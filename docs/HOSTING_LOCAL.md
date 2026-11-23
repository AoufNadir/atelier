# تشغيل رقمي من حاسوب المطبعة (المرحلة الأولى، مجانًا)

البرنامج يعمل على حاسوب المطبعة، ويبدأ وحده بعد تشغيل الحاسوب وتسجيل الدخول إلى Windows. الهواتف والحواسيب الأخرى تفتحه برابط https آمن من Tailscale. نسخة احتياطية يومية تذهب إلى Google Drive.

الموقع الحقيقي هو `nasaq.localhost`، وهو نظيف. `development.localhost` للتطوير فقط ولا تُدخل فيه بيانات حقيقية.

**متى لا يعمل:** إذا كان الحاسوب مطفأ، أو نائمًا، أو بلا إنترنت، فلا يصل إليه أحد من الخارج. داخل المطبعة يعمل ما دام الحاسوب شغالًا. بعد اكتمال التطوير يُنقل إلى خادم بنسخة احتياطية واحدة دون تغيير البرنامج.

كل الأوامر في PowerShell داخل `C:\Projects\atelier`.

## 1. منع نوم الحاسوب

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

لا يظهر شيء. الشاشة يمكن أن تنطفئ، المهم ألا ينام الحاسوب.

## 2. Google Drive للحاسوب

ثبّت «Google Drive for desktop» من موقع Google وسجّل الدخول بحسابك. يظهر قرص جديد، غالبًا `G:`، وفيه `My Drive`.

## 3. التشغيل التلقائي والنسخ اليومي

```powershell
.\tools\dev\Install-Nasaq-Autostart.ps1 -BackupDestination 'G:\My Drive\raqmi-backups'
```

يجب أن ترى: `OK: 'Raqmi Start' at logon, 'Raqmi Backup' daily at 14:00 -> G:\My Drive\raqmi-backups`

جرّب النسخة الاحتياطية الآن مرة واحدة:

```powershell
.\tools\dev\Backup-Nasaq.ps1 -Destination 'G:\My Drive\raqmi-backups'
```

يجب أن ترى سطرًا يبدأ بـ `backup:` ومعه حجم النسخة، وأن يظهر مجلد جديد في `G:\My Drive\raqmi-backups`. تُحفظ آخر 14 نسخة وتُحذف الأقدم. النسخة تشمل إعدادات الموقع (ومنها مفتاح التشفير اللازم للاسترجاع)، فلا تشارك هذا المجلد مع أحد.

**إذا انفصل Google Drive:** تُحفظ النسخة مؤقتًا في `%LOCALAPPDATA%\Nasaq\pending-backups` وتُنقل إلى Drive في أول تشغيل يجده متصلًا. وإذا مرّ يومان دون نسخة في Drive يظهر تنبيه في الملخص الصباحي للمدير.

## 4. إيقاف التسجيل المفتوح

لا يُنشئ حسابًا إلا المدير من الإعدادات:

```powershell
wsl -d Ubuntu-24.04 -- bash tools/dev/dc.sh "bench --site nasaq.localhost execute frappe.db.set_single_value --args \"['Website Settings','disable_signup',1]\""
```

لا يظهر خطأ.

## 5. الرابط من الهواتف (Tailscale Funnel)

1. ثبّت Tailscale لـ Windows من tailscale.com وسجّل الدخول (بحساب Google مثلًا). يعمل كخدمة ويبدأ مع Windows.
2. من لوحة Tailscale على الموقع: فعّل **HTTPS** و**Funnel** (تطلبهما الأداة في المرة الأولى وتعطيك الرابط).
3. شغّل:

```powershell
tailscale funnel --bg 8001
```

يجب أن ترى رابطًا مثل `https://اسم-حاسوبك.xxxx.ts.net`. افتح `https://اسم-حاسوبك.xxxx.ts.net/atelier-login` من هاتفك ببيانات الهاتف (لا الواي فاي) للتأكد. `--bg` يجعله يبقى بعد إعادة التشغيل.

لإيقاف الرابط: `tailscale funnel --https=443 off`

**الأمان:** الرابط عام وصفحة الدخول ظاهرة. كلمات مرور قوية لكل الحسابات، ولا تشارك حساب المدير.

## 6. التحقق بعد إعادة التشغيل

أعد تشغيل الحاسوب وسجّل الدخول، وانتظر دقيقتين، ثم افتح الرابط من الهاتف. إن لم يفتح:

```powershell
Get-ScheduledTaskInfo -TaskName 'Raqmi Start'
Get-Content "$env:LOCALAPPDATA\Nasaq\bench-error.log" -Tail 20
```

## الاسترجاع من نسخة احتياطية

لا يُنفَّذ إلا بقرار صريح، وعلى موقع يُراد استبدال بياناته. الأوامر تُعطى عند الحاجة.
