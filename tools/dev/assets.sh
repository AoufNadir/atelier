set -e
cd ~/erp/frappe_docker/development/frappe-bench
P=apps/atelier/atelier/public/atelier
mkdir -p $P/vendor && cp apps/frappe/node_modules/vue/dist/vue.esm-browser.prod.js $P/vendor/ && cp apps/frappe/node_modules/vue/LICENSE $P/vendor/vue-LICENSE.txt
cat > /tmp/mkicon.py <<'PY'
from PIL import Image, ImageDraw
import sys
for size in (192, 512):
    s = size / 512
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(96 * s), fill="#0F4C81")
    d.rounded_rectangle([136*s, 120*s, 376*s, 216*s], radius=int(12*s), outline="white", width=max(2, int(28*s)))
    d.rounded_rectangle([104*s, 216*s, 408*s, 344*s], radius=int(20*s), fill="white")
    d.rounded_rectangle([160*s, 300*s, 352*s, 404*s], radius=int(8*s), fill="#E7EEF6", outline="#0F4C81", width=max(2, int(16*s)))
    im.save(f"{sys.argv[1]}/icon-{size}.png")
PY
