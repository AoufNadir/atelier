# العمل من أكثر من حاسوب

## تجهيز حاسوب جديد

يلزم Windows 10/11 مع تفعيل المحاكاة الافتراضية في BIOS، و16 GB ذاكرة ونحو 40 GB مساحة حرة تقريبًا.

1. من PowerShell **كمسؤول**، ثم أعد التشغيل وأنشئ مستخدم Ubuntu:

   ```powershell
   wsl --install -d Ubuntu-24.04
   ```

2. ثبّت Git وانسخ المستودع (يطلب تسجيل الدخول إلى GitHub أول مرة):

   ```powershell
   winget install --id Git.Git -e
   git clone https://github.com/AoufNadir/atelier.git
   ```

3. من داخل مجلد المستودع، ثبّت Docker داخل WSL، ثم أغلق WSL وافتحه من جديد:

   ```powershell
   wsl -d Ubuntu-24.04 -- bash tools/dev/install_docker.sh
   wsl --shutdown
   ```

4. جهّز كل شيء. ستُطلب كلمة مرور Administrator للموقع، فاكتبها في الطرفية فقط:

   ```powershell
   wsl -d Ubuntu-24.04 -- bash tools/dev/bootstrap_nasaq.sh
   ```

5. التشغيل اليومي:

   ```powershell
   .\tools\dev\Start-Nasaq.ps1
   ```

   الرابط: <http://nasaq.localhost:8001/atelier-login>

لتغيير اسم الشركة أو غيره قبل الخطوة 4: انسخ `tools/dev/nasaq.env.example` إلى `tools/dev/nasaq.env`.

## المزامنة بين الحواسيب

**المهم: ما لم يُرفع إلى GitHub لا ينتقل. الحاسوب الآخر لا يرى التعديلات المحلية ولا الـcommits غير المرفوعة، حتى لو كان ملف الحالة محدثًا عندك.**

قبل مغادرة حاسوب:

```bash
git status
git add -A
git commit -m "وصف ما تم"
git push
```

حدّث PROJECT_STATUS.md قبل الـcommit. تأكد أن `git status` يقول إن الفرع متوافق مع origin.

عند البدء على حاسوب آخر:

```bash
git switch <الفرع>
git pull --ff-only
wsl -d Ubuntu-24.04 -- bash tools/dev/dc.sh "bench --site nasaq.localhost migrate"
```

الـmigrate لازم إذا تغيرت الحقول أو الـDocTypes.

### الحالات الصعبة

- **نسيت الرفع والحاسوب السابق مغلق:** التعديلات باقية عليه ولا يمكن استرجاعها من GitHub. تابع من آخر نقطة مرفوعة، وعند فتحه لاحقًا ارفعها على فرع مستقل ثم ادمجها.
- **تعديلات محلية غير محفوظة قبل pull:** احفظها في commit أولًا. لا تستخدم `git reset --hard` ولا `git push --force`.
- **`git pull --ff-only` يرفض:** الفرعان تباعدا. نفّذ `git pull --rebase`.
- **تعارض:** عدّل الملفات المذكورة، ثم `git add <الملف>` و`git rebase --continue`. للتراجع: `git rebase --abort`.
- **تعارض في PROJECT_STATUS.md:** أبقِ الأحدث وادمج أي خطوة ناقصة.

## البيانات: منفصلة عن الكود

GitHub لا ينقل قاعدة البيانات ولا الملفات المرفوعة ولا `site_config.json`. موقع كل حاسوب مستقل، ولذلك بيانات الحاسوب A لا تظهر على B. **حاليًا نبدأ نظيفًا ولا حاجة لشيء.** ولا تُحفظ النسخ الاحتياطية في المستودع أبدًا.

الخيارات لاحقًا، ولا يُنفَّذ أي منها إلا بقرار صريح:

| الخيار | مناسب عندما | المخاطر |
| --- | --- | --- |
| **خادم واحد** (خادم محلي بالورشة أو استضافة) تصل إليه كل الأجهزة | بيانات حقيقية وأكثر من مستخدم. **الخيار الموصى به للعمل الفعلي** | يحتاج نسخًا احتياطية وحماية وتحديثات |
| **نسخة احتياطية واستعادة** بين الحواسيب | التطوير والاختبار على بيانات واحدة | حاسوب واحد يعمل في كل مرة؛ العمل المتزامن يضيع |
| **قرص خارجي مشفّر أو تخزين خاص** لحمل النسخ | نقل يدوي دون خدمة خارجية | فقدان القرص، والنسخة تتقادم |

لا تُزامَن ملفات قاعدة البيانات الحية عبر Drive أو OneDrive، فهذا يتلفها.

نسخة واستعادة:

```bash
bench --site nasaq.localhost backup --with-files
bench --site nasaq.localhost restore <sql.gz> --with-public-files <files.tar> --with-private-files <private.tar>
```

الاستعادة تستبدل قاعدة الموقع الهدف. ويجب مطابقة `encryption_key` من `site_config.json` للمصدر، وإلا تعذر فك كلمات المرور المحفوظة. عامله كسر.
