import os
import hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _derive_key(master_key: str) -> bytes:
    return hashlib.sha256(master_key.encode("utf-8")).digest()


def decrypt_file_to_temp(encrypted_path: str, iv_hex: str, auth_tag_hex: str, master_key: str = None) -> str:
    """
    Decrypts an AES-256-GCM encrypted file (encrypted by the Node backend's
    fileEncryption.service.ts) to a temporary plaintext file and returns its
    path. Mirrors the Node implementation exactly: SHA-256(master_key) as
    the AES key, 12-byte IV, GCM auth tag appended by the AESGCM API.

    Node's crypto module keeps the auth tag separate from the ciphertext
    (returned via cipher.getAuthTag()); Python's `cryptography` AESGCM
    expects ciphertext+tag concatenated, so we reconstruct that here.
    """
    master_key = master_key or os.getenv("MFA_ENCRYPTION_KEY", "change_this_storage_encryption_key_in_prod")
    key = _derive_key(master_key)
    iv = bytes.fromhex(iv_hex)
    auth_tag = bytes.fromhex(auth_tag_hex)

    with open(encrypted_path, "rb") as f:
        ciphertext = f.read()

    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, ciphertext + auth_tag, None)

    temp_path = f"{encrypted_path}.decrypted.tmp"
    with open(temp_path, "wb") as f:
        f.write(plaintext)

    return temp_path
