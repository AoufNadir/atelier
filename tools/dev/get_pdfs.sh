#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Download demo quotation PDFs (dev site, dev default admin login) to docs/tests
set -e
O="$NASAQ_TOOLS_DIR/../docs/tests"; mkdir -p $O; J=$(mktemp)
U=http://development.localhost:8000
curl -s -c $J --resolve development.localhost:8000:127.0.0.1 -X POST $U/api/method/login -H 'Content-Type: application/json' -d '{"usr":"Administrator","pwd":"admin"}' >/dev/null
for l in ar fr; do
  curl -s -b $J --resolve development.localhost:8000:127.0.0.1 -o $O/quotation_standard_$l.pdf "$U/api/method/frappe.utils.print_format.download_pdf?doctype=Quotation&name=SAL-QTN-2026-00001&format=Standard&language=$l"
done
rm $J; ls -la $O
