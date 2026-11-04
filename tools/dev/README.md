# Development tools

Helper scripts for running the app on Windows + WSL (Ubuntu-24.04) + Docker (frappe_docker).
Paths are derived from each script's location, so the repository can live in any folder.
`lib.sh` and `Nasaq-Common.ps1` hold the shared settings; a computer that needs other
values copies `nasaq.env.example` to `nasaq.env` (git-ignored, never for passwords).
Setting up a new computer: see [`docs/WORKFLOW.md`](../../docs/WORKFLOW.md).

The checkout is mounted into the bench at `apps/atelier` (`compose.nasaq.yml`), so there is
only one copy of the code.

| Script | What it does |
| --- | --- |
| `bootstrap_nasaq.sh` | Full setup on a prepared computer: bench, clean site, apps, verification. |
| `Start-Nasaq.ps1` | Daily start from Windows: containers, bench, site web process, forwarding. |
| `Connect-GitHub.ps1` | Connects a ZIP-based checkout to origin. Reads only; pushes nothing. |
| `install_nasaq_apps.sh` | Registers the mounted app, installs ERPNext and Atelier, migrates. |
| `install_pdf_deps.sh` | Chromium libraries and Arabic fonts in the container; runs on setup and start. |
| `start.sh` | Starts the dev containers and `bench start`. |
| `dc.sh` | Runs a bench command inside the frappe container: `bash dc.sh "bench --site … migrate"`. |
| `commit_app.sh` | Commits the app with the message read from stdin. |
| `shots.mjs` | Headless Edge screenshots and UI checks at desktop and phone widths. `EDGE_PATH` and `NASAQ_BASE` override the defaults. Uses the dev default account. |
| `get_pdfs.sh` | Downloads each printed document type as PDF. |
| `setup_dev.sh`, `install_docker.sh`, `new_app.sh`, `git_init_app.sh`, `reset_site.sh` | First-time setup of the dev environment. `reset_site.sh` erases `development.localhost` and loads demo data. |
| `create_nasaq_site.sh`, `Create-Nasaq-Site*.ps1`, `finish_nasaq_setup.sh`, `verify_nasaq_site.py`, `run_nasaq_verification.sh` | Create and check the clean `nasaq.localhost` site. Passwords are typed privately in the terminal, never stored. |
| `start_nasaq*.sh`, `Start-Nasaq-Web.ps1`, `nasaq_local_proxy.py`, `compose.nasaq.yml`, `configure_nasaq_pdf_host.sh` | Run the clean site locally. |
| `check_*`, `inspect_*`, `reset_nasaq_administrator.py`, `Reset-Nasaq-Administrator.ps1` | Diagnostics and recovery. |

Never run the `demo_*` functions of `atelier/simple.py` or `atelier/production.py` on a real site.
