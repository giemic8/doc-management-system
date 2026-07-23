import os
import pytesseract
from pdf2image import convert_from_path
from pypdf import PdfReader

class OCREngine:
    @staticmethod
    def extract_text_from_file(file_path: str) -> str:
        """Extract text using pypdf text layer first, fallback to Tesseract OCR if text layer is empty."""
        extracted_text = ""
        
        # Try direct text extraction if PDF
        if file_path.lower().endswith('.pdf'):
            try:
                reader = PdfReader(file_path)
                for page in reader.pages:
                    text = page.extract_text()
                    if text:
                        extracted_text += text + "\n"
            except Exception as e:
                print(f"PDF direct text extraction notice: {e}")

        # If text is too short or empty, perform Tesseract OCR
        if len(extracted_text.strip()) < 50:
            print(f"Text layer too short/empty ({len(extracted_text)} chars). Running Tesseract OCR on {file_path}...")
            try:
                if file_path.lower().endswith('.pdf'):
                    images = convert_from_path(file_path, first_page=1, last_page=5) # First 5 pages
                    for img in images:
                        ocr_text = pytesseract.image_to_string(img, lang='deu+eng')
                        extracted_text += ocr_text + "\n"
                else:
                    # Single image file (PNG/JPG)
                    from PIL import Image
                    img = Image.open(file_path)
                    extracted_text = pytesseract.image_to_string(img, lang='deu+eng')
            except Exception as ocr_err:
                print(f"Tesseract OCR error: {ocr_err}")

        return extracted_text.strip()
