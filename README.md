# Atelier · نَسَق

An Arabic RTL print-workshop management app for Frappe 16 and ERPNext 16.
Its Vue 3 single-page interface is served at `/atelier`, with a branded sign-in
page at `/atelier-login`. The browser-ready JavaScript and Vue runtime ship with
the app: there is no frontend compilation or npm install step.

Atelier uses standard ERPNext customers, projects, tasks, sales documents and
payments, with workshop-specific fields, a production board, checklists and
Arabic print formats. It is an ERPNext app, not a standalone static website.

## Requirements

- A working Frappe **16** bench, ERPNext **16**, MariaDB, and the services Frappe needs.
- Python **3.14 or newer**, as declared in `pyproject.toml`.
- Read access to this private repository using your credential manager or deploy key.
- One company, country **Algeria**, currency **DZD**, and chart of accounts
  **Algerie - Plan Comptable General 2 avec code** for the workshop accounting setup.
- A PDF renderer supported by the bench, with Arabic fonts available on its host.

## Install on a fresh site

Run from your bench directory. Replace `<repo-url>` with
`https://github.com/AoufNadir/atelier.git` and `<site>` with the target site name.

```bash
bench get-app --branch main <repo-url>
bench --site <site> install-app erpnext
bench --site <site> install-app atelier
bench --site <site> migrate
```

Omit the ERPNext installation command if it is already installed on the site.
Use the normal Frappe deployment process to expose `/assets/atelier` and run
the bench services. Atelier's SPA requires no JavaScript build step.

For a new local site, let Bench prompt for the database root password and the new
Administrator password rather than saving them in scripts:

```bash
bench new-site nasaq.localhost --db-type mariadb
```

In Docker, configure the appropriate `--mariadb-user-host-login-scope` for the
separate database container. Do not expose MariaDB publicly in production.

Complete the ERPNext setup wizard before using Atelier:

| Field | Value |
| --- | --- |
| Company name | Your actual workshop's name |
| Company abbreviation | A short, stable abbreviation |
| Country | Algeria |
| Currency | DZD |
| Time zone | Africa/Algiers |
| Chart of accounts | Algerie - Plan Comptable General 2 avec code |
| Fiscal year | Your company's actual fiscal year |
| Demo data | Disabled |

Sign in at `/atelier-login` and open `/atelier`. Assign users the ERPNext sales,
projects, stock and accounting roles required for their work.

## Automatic setup and upgrades

`atelier/install.py` registers repeatable `after_install` and `after_migrate` hooks:

- Custom fields on Task, Item, Sales Order, Sales Order Item and Customer.
- Arabic quotation, order, delivery, invoice and receipt print formats.
- Selling price lists `سعر الأفراد` and `سعر المؤسسات`.
- Missing board columns/labels, checklist templates, document and alert defaults.
  Existing settings, including deliberately empty lists, are preserved.
- Arabic account display names, only for the matching Algerian chart in a
  single-company DZD site.

Company-dependent work is deferred until a company exists. The
`setup_wizard_complete` hook finishes it after ERPNext creates the chart; a later
migration also retries it. Arabic account initialization is recorded once, so
later migrations preserve customized account labels.

```bash
bench --site <site> migrate
```

No one-time patch is needed: the migration hook handles existing installations.
`patches.txt` remains available for future data migrations.

## Demo and developer tools — never run in production

Installation never imports or calls `atelier.demo`, `atelier.demo_cycle`, any
`demo_*` function, or `atelier.dev_build.build`. These tools are only for disposable
development sites and may create or modify sample customers, orders, payments,
team members or tags. Never call them on a real workshop site.

Schema-only helpers such as `dev_build.custom_fields`, `production.custom_fields`
and the `simple.*_fields` functions are used by the installer. The developer
`dev_build.build` function is different: DocType and report JSON files already ship
with the app and Frappe synchronizes them from a fresh clone.

Never copy `development.localhost`, its database or its files to a new site.
Keep site configuration, credentials and backups outside this repository.
`.gitignore` excludes them while retaining the code assets in `atelier/public`.

## Backups

```bash
bench --site <site> backup --with-files
```

The output is stored under `sites/<site>/private/backups/`. Treat the database,
files and configuration backups as sensitive. Store them securely; never commit them.

## ملخص بالعربية

«نَسَق» تطبيق عربي لإدارة المطبعة على Frappe 16 وERPNext 16. الواجهة على
`/atelier` وتسجيل الدخول على `/atelier-login`. يجهز التثبيت الحقول ولوحة الطلبات
وقوالب المهام وقوائم الأسعار والطباعة تلقائيًا، دون بيانات تجريبية. أكمل إعداد
شركة جزائرية بعملة DZD ودليل الحسابات المذكور. لا تشغّل دوال `demo_*` ولا تنقل
قاعدة الموقع التجريبي إلى موقع العمل.

## License

GPL-3.0. The vendored Vue runtime has its own license at
`atelier/public/atelier/vendor/vue-LICENSE.txt`.
