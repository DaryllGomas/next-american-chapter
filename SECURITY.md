# Security

Found a vulnerability, a way to stuff votes, or something that exposes voter data? Please report it privately through
GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue.

What we store: votes and write-ins keyed by a salted hash of a random browser cookie, plus a salted hash of the IP that
rotates daily (for rate limits). No raw IP addresses, emails or accounts are stored. Feedback text is stored without
any identity.
