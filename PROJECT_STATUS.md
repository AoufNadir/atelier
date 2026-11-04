# حالة المشروع — Atelier · نَسَق

آخر تحديث: 2026-11-04، على حاسوب Windows الجديد (مجلد `atelier-main` من ZIP).

## الحالة الآن

**التطبيق لا يعمل بعد على أي بيئة في متناولنا.** ثُبّت WSL 2.7.14 بنجاح وفُعّل VirtualMachinePlatform، لكن Windows يطلب إعادة تشغيل قبل المتابعة. Ubuntu وDocker لم يُثبّتا بعد.

- الفرع: `chore/multi-computer-setup` (commits محلية **غير مرفوعة**).
- سجل Git محلي بدأ من لقطة ZIP (الوسم `zip-baseline`)، وليس سجل GitHub بعد؛ لأن المستودع خاص ويتطلب تسجيل دخول.
- نسخة احتياطية لمحتوى ZIP الأصلي: `C:\Users\HB\Documents\atelier-main-backup-zip-original.zip`.
- الجلسة السابقة غير متاحة؛ هذه الحالة مستخرجة من الملفات. سجل GitHub لم يُقرأ بعد، وقد يحتوي عملًا أحدث من ZIP.

## ما اكتمل

موجود في الكود (لم يُشغَّل هنا): واجهة `/atelier` وتسجيل الدخول، ولوحة الطلبات، وقوالب المهام، والفريق، والعملاء، والأسعار، والطباعة العربية، والحسابات العربية، وتثبيت قابل للتكرار.

تم في هذه الجلسة:

- إزالة مسارات الحاسوب القديم من `tools/dev` (`F:\App\ERP`، و`C:\Users\User\.codex`)، ووضع الإعدادات في `lib.sh` و`Nasaq-Common.ps1`.
- `setup_dev.sh` ينسخ frappe_docker عند غيابه، وأضيف `bootstrap_nasaq.sh` و`install_nasaq_apps.sh` و`Start-Nasaq.ps1` و`Connect-GitHub.ps1`.
- تركيب المستودع داخل الـbench، لتبقى نسخة واحدة من الكود.
- التثبيت يهيئ `atelier_team` بقائمة فارغة دون استبدال الموجود.
- `verify_nasaq_site.py` لم يعد يفرض الاختصار NSQ، ويفحص الفريق والحسابات العربية.
- `finish_nasaq_setup.sh`: اسم الشركة والسنة المالية قابلان للتغيير.
- `.gitattributes` و`.gitignore` ووثائق المزامنة والقرارات.

## التحقق الذي تم فعلًا

- `bash -n` لكل سكربتات `.sh`، وتحليل PowerShell لكل `.ps1`، و`compileall` لكل Python (Python 3.14): ناجحة.
- اختبار لمنطق `install.py` مع frappe وهمي: ناجح (الافتراضيات، وحفظ الموجود والفارغ، والحسابات مرة واحدة بعد المعالج).

## لم يُختبر

تشغيل أي سكربت فعليًا، وتركيب المجلد في الحاوية، و`install_nasaq_apps.sh` و`bootstrap_nasaq.sh`، والتثبيت الحقيقي على ERPNext، والواجهة، وPDF، و`Connect-GitHub.ps1`، و`atelier/tests`.

## مشكلات معروفة

- `install_docker.sh` يحتاج systemd داخل WSL، وهو المتوقع افتراضيًا في Ubuntu-24.04 (لم يُتحقق منه هنا).
- `reset_nasaq_administrator.py` و`get_pdfs.sh` و`reset_site.sh` تفترض مواقع التطوير الافتراضية.
- `hooks.py` و`pyproject.toml` ما زالا يذكران `Demo Atelier` كناشر (معلومة شكلية، لم تُغيَّر).

## الخطوة التالية المحددة

1. المستخدم: احفظ عملك وأعد تشغيل Windows. بعد العودة افحص `wsl --status` و`wsl --list --verbose`، ثم أكمل `wsl --install -d Ubuntu-24.04` وأنشئ مستخدم Ubuntu إذا لزم.
2. ثُبّت GitHub CLI 2.103.3 في `C:\Program Files\GitHub CLI\gh.exe`. تسجيل الدخول لم يُؤكّد بعد؛ افحص `gh auth status` وأكمل تسجيل الدخول عند الحاجة، ثم شغّل `tools/dev/Connect-GitHub.ps1`. لا ترفع أي تغييرات دون طلب المستخدم.
3. ثبّت Docker، وشغّل `bootstrap_nasaq.sh`، وصحّح ما يظهر حتى ينجح `verify_nasaq_site.py`.
4. اختبر الواجهة على `http://nasaq.localhost:8001/atelier-login`.
5. حدّث هذا الملف، وارفع عند طلب المستخدم فقط.

## تجهيز المتطلبات — متابعة 2026-11-04

- طلب المستخدم من Codex تثبيت المتطلبات لمساعدة جلسة Claude.
- نجح تثبيت WSL من حزمة Microsoft الرسمية بواسطة winget بصلاحية مدير. تحقق `wsl --version`: الإصدار 2.7.14.0، والنواة 6.18.33.2-2.
- نجح تفعيل VirtualMachinePlatform، وأبلغ Windows صراحة أن التغييرات تتطلب إعادة تشغيل. لم تتم إعادة التشغيل تلقائيًا.
- `wsl --list --verbose` لا يعرض توزيعات مثبتة. محاولة تثبيت Ubuntu-24.04 توقفت عند شرط إعادة التشغيل؛ لا تُعتبر Ubuntu مثبتة.
- فحص العتاد أظهر `VirtualizationFirmwareEnabled=True`؛ أعد فحص WSL بعد إعادة التشغيل قبل افتراض الحاجة لتغيير BIOS.
- نجح تثبيت GitHub CLI 2.103.3. لم يُتحقق بعد من اكتمال تسجيل الدخول، ولم يُربط السجل المحلي بسجل GitHub ولم يُرفع شيء.
- Docker وERPNext واختبارات التطبيق لم تُشغّل بعد. لا تضغط «تم، أكمل التشغيل» على أساس أن البيئة جاهزة بالكامل.
