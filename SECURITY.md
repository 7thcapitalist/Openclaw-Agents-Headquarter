# Security Notes

This repo is intentionally a clean publishable slice of a private automation setup.

Do not commit:

- `~/.openclaw/openclaw.json`
- dashboard `.env` files
- API keys, tokens, auth profiles, cookies, or Telegram/Gmail credentials
- SQLite runtime databases
- agent logs and outputs that contain personal data

The dashboard only runs registered agents through `./run.sh`. Keep that boundary narrow if you extend it.
