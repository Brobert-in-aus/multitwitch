#!/usr/bin/env python3
"""Generate the ANALYTICS_DASHBOARD_PASSWORD_HASH value for the usage dashboard.

Prompts for a password (or reads one argument) and prints the env line to add to
/etc/multistream.env on the VPS. The plaintext password is never stored; only the
PBKDF2 hash is. Setting the hash enables the login-gated dashboard at /admin/usage;
leaving it unset keeps the dashboard disabled (404).

    python scripts/hash_dashboard_password.py
    python scripts/hash_dashboard_password.py 'my-password'   # non-interactive
"""

import getpass
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from multitwitch.lib.passwords import hash_password  # noqa: E402


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        password = argv[0]
    else:
        password = getpass.getpass('Dashboard password: ')
        if password != getpass.getpass('Confirm password: '):
            print('Passwords did not match.', file=sys.stderr)
            return 1
    if len(password) < 8:
        print('Password must be at least 8 characters.', file=sys.stderr)
        return 1

    encoded = hash_password(password)
    print('# Add this line to /etc/multistream.env, then restart the container:')
    print('ANALYTICS_DASHBOARD_PASSWORD_HASH=%s' % encoded)
    return 0


if __name__ == '__main__':
    sys.exit(main())
