# Development tools

Helper scripts used to run and check the app on a Windows + WSL (Ubuntu-24.04) + Docker
(frappe_docker) machine. They are copied here from `F:\App\ERP\scripts`; several of them
still call `/mnt/f/App/ERP/scripts/...` and expect the bench at
`~/erp/frappe_docker/development/frappe-bench`. On another computer either use the same
folders or adjust those paths.

| Script | What it does |
| --- | --- |
| `start.sh` | Starts the frappe_docker dev containers and `bench start`. |
| `dc.sh` | Runs a bench command inside the frappe container: `bash dc.sh "bench --site … migrate"`. |
| `commit_app.sh` | Commits the app with the message read from stdin. |
| `shots.mjs` | Headless Edge: screenshots of every page at desktop and phone widths and UI checks (overflow, font, clipping). `node tools/dev/shots.mjs` → `docs/screenshots`. Signs in with frappe_docker's default dev account. |
| `get_pdfs.sh` | Downloads each printed document type as PDF. |
| `setup_dev.sh`, `install_docker.sh`, `new_app.sh`, `git_init_app.sh`, `reset_site.sh` | First-time setup of the dev environment. |
| `create_nasaq_site.sh`, `Create-Nasaq-Site*.ps1`, `finish_nasaq_setup.sh`, `verify_nasaq_site.py`, `run_nasaq_verification.sh` | Create and check the clean `nasaq.localhost` site. Passwords are typed privately in the terminal, never stored. |
| `start_nasaq*.sh`, `Start-Nasaq-Web.ps1`, `nasaq_local_proxy.py`, `compose.nasaq.yml`, `configure_nasaq_pdf_host.sh` | Run the clean site locally. |
| `check_*`, `inspect_*`, `reset_nasaq_administrator.py`, `Reset-Nasaq-Administrator.ps1` | Diagnostics and recovery. |

Never run the `demo_*` functions of `atelier/simple.py` or `atelier/production.py` on a real site.
