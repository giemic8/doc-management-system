import os
import json
import re
import requests

# Ticket #35 -- every extracted field carries a confidence, and the database
# decides from it whether the value is applied or handed to a person.
FIELD_KEYS = ("doc_type", "sender", "recipient", "document_date", "due_date", "amount", "summary", "tags")

# Fields whose value must literally stand in the document. A model that
# invents a sender or a due date is exactly the failure this ticket exists to
# catch, so a value the text does not support keeps only a fraction of the
# confidence the model claimed for it.
GROUNDED_FIELDS = ("sender", "recipient", "document_date", "due_date", "amount")

# What a model gets when it returns a value but no usable self-assessment.
# Deliberately below a default auto-accept threshold: silence about
# confidence is not evidence of confidence.
LLM_DEFAULT_CONFIDENCE = 0.7
UNGROUNDED_PENALTY = 0.55

# The regex fallback is evidence of a keyword, not of understanding. These
# values sit in the band that proposes to a reviewer without ever applying
# itself, so an offline provider fills the inbox instead of the archive.
HEURISTIC_CONFIDENCE = {
    "doc_type_matched": 0.6,
    "doc_type_default": 0.3,
    "amount": 0.65,
    "document_date": 0.65,
    "summary": 0.3,
    "tags": 0.35,
}


def _normalize(text: str) -> str:
    """Lowercased, punctuation-free form used for grounding comparisons."""
    return re.sub(r'[^0-9a-zäöüß]+', ' ', (text or '').lower()).strip()


def _date_renderings(value: str) -> list:
    """The ways a YYYY-MM-DD date plausibly appears in a German document."""
    match = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', str(value).strip())
    if not match:
        return [str(value)]
    year, month, day = match.groups()
    return [
        f"{year}-{month}-{day}",
        f"{day}.{month}.{year}",
        f"{int(day)}.{int(month)}.{year}",
        f"{day}/{month}/{year}",
        f"{day}{month}{year}",
    ]


def _amount_renderings(value) -> list:
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return [str(value)]
    plain = f"{amount:.2f}"
    return [plain, plain.replace('.', ','), plain.rstrip('0').rstrip('.')]


def is_grounded(field: str, value, ocr_text: str) -> bool:
    """True when the document itself supports the value."""
    normalized_text = _normalize(ocr_text)
    if not normalized_text:
        return False

    if field in ("document_date", "due_date"):
        return any(_normalize(rendering) in normalized_text for rendering in _date_renderings(value))

    if field == "amount":
        return any(_normalize(rendering) in normalized_text for rendering in _amount_renderings(value))

    normalized_value = _normalize(str(value))
    if not normalized_value:
        return False
    if normalized_value in normalized_text:
        return True
    # A company name survives OCR unevenly; one distinctive word of it
    # standing in the text is enough to call the value grounded.
    distinctive = [token for token in normalized_value.split() if len(token) >= 4]
    return any(token in normalized_text for token in distinctive)


def _clean_value(field: str, value):
    """Drops values that carry no information, so they never reach the inbox."""
    if value is None:
        return None
    if field == "tags":
        if not isinstance(value, list):
            return None
        tags = [str(tag).strip() for tag in value if str(tag).strip()]
        return tags or None
    if field == "amount":
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    text = str(value).strip()
    if not text or text.lower() in ("null", "none", "unbekannt", "unknown", "n/a"):
        return None
    return text


def _reported_confidence(reported, field: str):
    if not isinstance(reported, dict):
        return None
    raw = reported.get(field)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value < 0 or value > 1:
        return None
    return value


def score_extraction(meta: dict, ocr_text: str, source: str) -> dict:
    """Turns a raw extraction into one scored proposal per field.

    Pure function: no I/O, no provider. It is where the model's own claim
    about a field meets what the document actually says.
    """
    reported = meta.get("confidence") if isinstance(meta, dict) else None
    heuristic_scores = meta.get("_heuristic_confidence") if isinstance(meta, dict) else None
    fields = {}

    for field in FIELD_KEYS:
        value = _clean_value(field, meta.get(field) if isinstance(meta, dict) else None)
        if value is None:
            # Nothing was found. That is an answer, not an uncertainty, and
            # it must not drag the document into the review inbox.
            continue

        if source == "heuristic":
            confidence = (heuristic_scores or {}).get(field, 0.3)
        else:
            confidence = _reported_confidence(reported, field)
            if confidence is None:
                confidence = LLM_DEFAULT_CONFIDENCE

        if field in GROUNDED_FIELDS and not is_grounded(field, value, ocr_text):
            confidence *= UNGROUNDED_PENALTY

        fields[field] = {"value": value, "confidence": round(max(0.0, min(1.0, confidence)), 3)}

    return fields


class AIExtractor:
    def __init__(self):
        self.provider = os.getenv("LLM_PROVIDER", "ollama")
        self.ollama_host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
        self.openai_api_key = os.getenv("OPENAI_API_KEY", "")
        self.ollama_model = os.getenv("OLLAMA_MODEL", "llama3")
        self.openai_model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    def extract_metadata(self, ocr_text: str) -> dict:
        """Extracts document metadata as scored proposals.

        Returns {"provider", "model", "fields": {field: {value, confidence}}}.
        The caller stores proposals; it never writes them onto the document
        itself -- that decision belongs to the configured thresholds.
        """
        if not ocr_text or len(ocr_text.strip()) == 0:
            meta = self._heuristic_fallback("")
            return {"provider": "heuristic", "model": None, "fields": score_extraction(meta, "", "heuristic")}

        prompt = f"""Du bist ein präzises Assistenzsystem für Dokumentenverwaltung. Analysiere den folgenden Text eines eingescannten Dokumentes und liefere NUR ein gültiges JSON-Objekt ohne Erklärungen mit genau folgenden Schlüsseln:
- doc_type: (z.B. "Rechnung", "Vertrag", "Steuerbescheid", "Brief", "Quittung", "Versicherungspolice", "Sonstiges")
- sender: (Absender/Unternehmen oder Person, string oder null)
- recipient: (Empfänger, string oder null)
- document_date: (YYYY-MM-DD oder null)
- due_date: (YYYY-MM-DD oder null)
- amount: (Rechnungsbetrag als float z.B. 49.90 oder null)
- summary: (Prägnante Zusammenfassung in 1-2 Sätzen, string)
- tags: (Array von 2-4 prägnanten Schlagwörtern, array of strings)
- confidence: (Objekt mit demselben Schlüssel für jedes der obigen Felder und einer Zahl zwischen 0 und 1, die angibt, wie sicher der Wert aus dem Text belegt ist. Gib 0, wenn der Wert geraten ist.)

Setze ein Feld auf null, statt zu raten.

DOKUMENTEN-TEXT:
{ocr_text[:3000]}
"""

        try:
            if self.provider == "ollama":
                res = requests.post(
                    f"{self.ollama_host}/api/generate",
                    json={
                        "model": self.ollama_model,
                        "prompt": prompt,
                        "stream": False,
                        "format": "json"
                    },
                    timeout=30
                )
                if res.status_code == 200:
                    resp_json = res.json()
                    response_text = resp_json.get("response", "")
                    meta = json.loads(response_text)
                    return {
                        "provider": "ollama",
                        "model": self.ollama_model,
                        "fields": score_extraction(meta, ocr_text, "llm"),
                    }
            elif self.provider == "openai" and self.openai_api_key:
                res = requests.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {self.openai_api_key}"},
                    json={
                        "model": self.openai_model,
                        "messages": [{"role": "user", "content": prompt}],
                        "response_format": {"type": "json_object"}
                    },
                    timeout=30
                )
                if res.status_code == 200:
                    content = res.json()["choices"][0]["message"]["content"]
                    meta = json.loads(content)
                    return {
                        "provider": "openai",
                        "model": self.openai_model,
                        "fields": score_extraction(meta, ocr_text, "llm"),
                    }
        except Exception as err:
            print(f"AI LLM Call notice/fallback triggered: {err}")

        meta = self._heuristic_fallback(ocr_text)
        return {
            "provider": "heuristic",
            "model": None,
            "fields": score_extraction(meta, ocr_text, "heuristic"),
        }

    def _heuristic_fallback(self, ocr_text: str) -> dict:
        """Regex-based fallback extraction if the LLM is offline.

        Carries its own per-field confidences: a keyword match is real but
        weak evidence, so these land in the band that asks a person rather
        than the one that writes to the document.
        """
        doc_type = "Sonstiges"
        doc_type_matched = True
        if re.search(r'rechnung|invoice|faktura', ocr_text, re.I):
            doc_type = "Rechnung"
        elif re.search(r'vertrag|agreement|contract', ocr_text, re.I):
            doc_type = "Vertrag"
        elif re.search(r'steuer|finanzamt', ocr_text, re.I):
            doc_type = "Steuerdokument"
        else:
            doc_type_matched = False

        # Try extract amount
        amount_match = re.search(r'(\d+[\.,]\d{2})\s*(?:€|EUR)', ocr_text)
        amount = None
        if amount_match:
            try:
                amount = float(amount_match.group(1).replace(',', '.'))
            except ValueError:
                amount = None

        # Try extract date
        date_match = re.search(r'(\d{2})[\./-](\d{2})[\./-](\d{4})', ocr_text)
        doc_date = None
        if date_match:
            day, month, year = date_match.groups()
            doc_date = f"{year}-{month}-{day}"

        return {
            "doc_type": doc_type,
            # No sender is honest; "Unbekannt" was a value that looked like one.
            "sender": None,
            "recipient": None,
            "document_date": doc_date,
            "due_date": None,
            "amount": amount,
            "summary": ocr_text[:150] + "..." if ocr_text else "Automatisch erfasstes Dokument.",
            "tags": [doc_type, "Automatisch"],
            "_heuristic_confidence": {
                "doc_type": HEURISTIC_CONFIDENCE["doc_type_matched"] if doc_type_matched
                else HEURISTIC_CONFIDENCE["doc_type_default"],
                "amount": HEURISTIC_CONFIDENCE["amount"],
                "document_date": HEURISTIC_CONFIDENCE["document_date"],
                "summary": HEURISTIC_CONFIDENCE["summary"],
                "tags": HEURISTIC_CONFIDENCE["tags"],
            },
        }
