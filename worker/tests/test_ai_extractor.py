"""Ticket #35 -- the pure half of extraction confidence.

The thresholds themselves live in the database (`review_settings`) and are
covered by the backend suite. What is tested here is the score those
thresholds are applied to: whether the document actually supports the value
the model returned.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from ai_extractor import AIExtractor, is_grounded, score_extraction  # noqa: E402

INVOICE_TEXT = """
Stadtwerke Musterstadt GmbH
Rechnung Nr. 2026-4711
Rechnungsdatum: 24.03.2026
Faellig am: 07.04.2026
Rechnungsbetrag: 49,90 EUR
"""


def test_a_grounded_value_keeps_the_confidence_the_model_claimed():
    fields = score_extraction(
        {
            "sender": "Stadtwerke Musterstadt GmbH",
            "confidence": {"sender": 0.93},
        },
        INVOICE_TEXT,
        "llm",
    )
    assert fields["sender"]["confidence"] == 0.93


def test_an_ungrounded_value_loses_most_of_its_confidence():
    fields = score_extraction(
        {
            "sender": "Vollkommen Erfundene AG",
            "confidence": {"sender": 0.99},
        },
        INVOICE_TEXT,
        "llm",
    )
    # 0.99 * 0.55, rounded to what the NUMERIC(4,3) column can hold -- below
    # any sane auto-accept threshold, so a claim the document does not
    # support reaches a person instead of the archive.
    assert fields["sender"]["confidence"] == pytest.approx(0.544, abs=0.001)
    assert fields["sender"]["confidence"] < 0.85


def test_a_field_the_model_left_empty_produces_no_proposal():
    fields = score_extraction(
        {"doc_type": "Rechnung", "due_date": None, "sender": "   "},
        INVOICE_TEXT,
        "llm",
    )
    assert "due_date" not in fields
    assert "sender" not in fields
    assert "doc_type" in fields


def test_a_placeholder_sender_is_not_a_value():
    fields = score_extraction({"sender": "Unbekannt"}, INVOICE_TEXT, "llm")
    assert "sender" not in fields


def test_dates_are_grounded_in_their_german_rendering():
    assert is_grounded("document_date", "2026-03-24", INVOICE_TEXT)
    assert is_grounded("due_date", "2026-04-07", INVOICE_TEXT)
    assert not is_grounded("document_date", "2019-01-02", INVOICE_TEXT)


def test_amounts_are_grounded_across_decimal_separators():
    assert is_grounded("amount", 49.9, INVOICE_TEXT)
    assert is_grounded("amount", 49.9, "Betrag: 49.90 EUR")
    assert not is_grounded("amount", 51.0, INVOICE_TEXT)


def test_one_distinctive_word_grounds_a_company_name():
    assert is_grounded("sender", "Stadtwerke Musterstadt Gesellschaft", INVOICE_TEXT)
    assert not is_grounded("sender", "Andere Firma", INVOICE_TEXT)


def test_an_unusable_reported_confidence_falls_back_to_the_default():
    fields = score_extraction(
        {"doc_type": "Rechnung", "confidence": {"doc_type": "sehr sicher"}},
        INVOICE_TEXT,
        "llm",
    )
    assert fields["doc_type"]["confidence"] == 0.7

    out_of_range = score_extraction(
        {"doc_type": "Rechnung", "confidence": {"doc_type": 7}},
        INVOICE_TEXT,
        "llm",
    )
    assert out_of_range["doc_type"]["confidence"] == 0.7


def test_tags_are_cleaned_and_a_non_list_is_refused():
    fields = score_extraction({"tags": ["Rechnung", "  ", "Energie"]}, INVOICE_TEXT, "llm")
    assert fields["tags"]["value"] == ["Rechnung", "Energie"]

    assert "tags" not in score_extraction({"tags": "Rechnung"}, INVOICE_TEXT, "llm")


def test_the_regex_fallback_never_reaches_the_auto_accept_band():
    extractor = AIExtractor()
    fallback = extractor._heuristic_fallback(INVOICE_TEXT)
    fields = score_extraction(fallback, INVOICE_TEXT, "heuristic")

    assert fields, "the fallback should still propose something"
    for field, proposal in fields.items():
        assert proposal["confidence"] < 0.85, f"{field} would have been applied unreviewed"

    # A matched keyword is weak evidence, but it is evidence: it stays above
    # the band where a proposal is withheld from the reviewer entirely.
    assert fields["doc_type"]["value"] == "Rechnung"
    assert fields["doc_type"]["confidence"] >= 0.5


def test_the_fallback_invents_no_sender_for_an_empty_document():
    extractor = AIExtractor()
    fields = score_extraction(extractor._heuristic_fallback(""), "", "heuristic")
    assert "sender" not in fields
