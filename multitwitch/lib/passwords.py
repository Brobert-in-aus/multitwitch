"""Password hashing for the usage dashboard's single-admin login.

Mirrors the workout tracker's approach (a hashed password, never plaintext, kept
out of the repo) but stays stdlib-only: PBKDF2-HMAC-SHA256 via hashlib instead of
pulling in a bcrypt dependency. The encoded form is self-describing:

    pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>

Generate one with scripts/hash_dashboard_password.py and put it in
ANALYTICS_DASHBOARD_PASSWORD_HASH (see README).
"""

import hashlib
import hmac
import os

ALGORITHM = 'pbkdf2_sha256'
DEFAULT_ITERATIONS = 600000  # OWASP 2023 guidance for PBKDF2-HMAC-SHA256
SALT_BYTES = 16


def hash_password(password, iterations=DEFAULT_ITERATIONS):
    salt = os.urandom(SALT_BYTES)
    digest = _pbkdf2(password, salt, iterations)
    return '%s$%d$%s$%s' % (ALGORITHM, iterations, salt.hex(), digest.hex())


def verify_password(password, encoded):
    """Constant-time check of `password` against a stored encoded hash."""
    try:
        algorithm, iterations, salt_hex, hash_hex = encoded.split('$')
        if algorithm != ALGORITHM:
            return False
        iterations = int(iterations)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (AttributeError, ValueError):
        return False
    digest = _pbkdf2(password, salt, iterations)
    return hmac.compare_digest(digest, expected)


def _pbkdf2(password, salt, iterations):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, iterations)
