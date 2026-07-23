import os
import json
import re
import requests

class AIExtractor:
    def __init__(self):
        self.provider = os.getenv("LLM_PROVIDER", "ollama")
        self.ollama_host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
        self.openai_api_key = os.getenv("OPENAI_API_KEY", "")

    def extract_metadata(self, ocr_text: str) -> dict:
        """Call LLM or fallback heuristics to extract document_type, sender, document_date, amount, tags, summary."""
        if not ocr_text or len(ocr_text.strip()) == 0:
            return self._heuristic_fallback("")

        prompt = f"""Du bist ein präzises Assistenzsystem für Dokumentenverwaltung. Analysiere den folgenden Text eines eingescannten Dokumentes und liefere NUR ein gültiges JSON-Objekt ohne Erklärungen mit genau folgenden Schlüsseln:
- doc_type: (z.B. "Rechnung", "Vertrag", "Steuerbescheid", "Brief", "Quittung", "Versicherungspolice", "Sonstiges")
- sender: (Absender/Unternehmen oder Person, string oder null)
- recipient: (Empfänger, string oder null)
- document_date: (YYYY-MM-DD oder null)
- due_date: (YYYY-MM-DD oder null)
- amount: (Rechnungsbetrag als float z.B. 49.90 oder null)
- summary: (Prägnante Zusammenfassung in 1-2 Sätzen, string)
- tags: (Array von 2-4 prägnanten Schlagwörtern, array of strings)

DOKUMENTEN-TEXT:
{ocr_text[:3000]}
"""

        try:
            if self.provider == "ollama":
                res = requests.post(
                    f"{self.ollama_host}/api/generate",
                    json={
                        "model": "llama3",
                        "prompt": prompt,
                        "stream": False,
                        "format": "json"
                    },
                    timeout=30
                )
                if res.status_code == 200:
                    resp_json = res.json()
                    response_text = resp_json.get("response", "")
                    return json.loads(response_text)
            elif self.provider == "openai" and self.openai_api_key:
                res = requests.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {self.openai_api_key}"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [{"role": "user", "content": prompt}],
                        "response_format": {"type": "json_object"}
                    },
                    timeout=30
                )
                if res.status_code == 200:
                    content = res.json()["choices"][0]["message"]["content"]
                    return json.loads(content)
        except Exception as err:
            print(f"AI LLM Call notice/fallback triggered: {err}")

        return self._heuristic_fallback(ocr_text)

    def _heuristic_fallback(self, ocr_text: str) -> dict:
        """Regex-based fallback extraction if LLM is offline."""
        doc_type = "Sonstiges"
        if re.search(r'rechnung|invoice|faktura', ocr_text, re.I):
            doc_type = "Rechnung"
        elif re.search(r'vertrag|agreement|contract', ocr_text, re.I):
            doc_type = "Vertrag"
        elif re.search(r'steuer|finanzamt', ocr_text, re.I):
            doc_type = "Steuerdokument"

        # Try extract amount
        amount_match = re.search(r'(\d+[\.,]\d{2})\s*(?:€|EUR)', ocr_text)
        amount = None
        if amount_match:
            try:
                amount = float(amount_match.group(1).replace(',', '.'))
            except:
                pass

        # Try extract date
        date_match = re.search(r'(\d{2})[\./-](\d{2})[\./-](\d{4})', ocr_text)
        doc_date = None
        if date_match:
            day, month, year = date_match.groups()
            doc_date = f"{year}-{month}-{day}"

        return {
            "doc_type": doc_type,
            "sender": "Unbekannt",
            "recipient": None,
            "document_date": doc_date,
            "due_date": None,
            "amount": amount,
            "summary": ocr_text[:150] + "..." if ocr_text else "Automatisch erfasstes Dokument.",
            "tags": [doc_type, "Automatisch"]
        }
