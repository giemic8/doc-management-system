# Ticket #1: [Feature] Multi-Factor Authentication (MFA / TOTP)

## Type
`security`, `enhancement`

## Description
To meet enterprise security standards beyond basic password authentication, implement Time-based One-Time Password (TOTP) Multi-Factor Authentication (MFA) for user logins.

## Acceptance Criteria
- [ ] Users can enable MFA in their user profile settings.
- [ ] Display a QR Code for scanning with authenticator apps (Google Authenticator, Bitwarden, 1Password).
- [ ] Provide 8-digit backup recovery codes during setup.
- [ ] Enforce TOTP code verification on `/api/auth/login`.
- [ ] Admin users can enforce MFA requirement for all editors.
