# SISPAA — Portal Analisis Aduan Awam JPN Kedah

- `index.html` — frontend (papan pemuka, direktori kes, SLA & KPI, daftar manual).
- `apps-script/Code.gs` — backend Google Apps Script yang terikat pada Google Sheet pangkalan data.

## Keselamatan (v3)

- Tiada kata laluan dalam `index.html`. Log masuk disemak oleh Apps Script. Kata laluan disimpan sebagai hash dalam **Script Properties**.
- Setiap permintaan membawa token sesi (tamat selepas 6 jam). ID dikunci 15 minit selepas 5 cubaan gagal.
- Data dibaca melalui `METHOD=LIST` dan ditapis ikut PPD di pelayan. CSV "Publish to web" tidak digunakan lagi.
- PENGARAH/TIMBALAN hanya boleh baca. Akaun PPD hanya boleh tambah, ubah atau padam kes PPD sendiri.
- Padam (`METHOD=DELETE`) memindahkan baris ke sheet `Dipadam`, jadi rekod boleh dipulihkan.

## Pemasangan / kemas kini backend

1. Buka Google Sheet → **Extensions → Apps Script**. Gantikan kandungan `Code.gs` dengan `apps-script/Code.gs`.
2. **Tetapkan kata laluan baharu.** Kata laluan lama pernah terdedah dalam kod, jadi jangan gunakannya lagi.
   1. Dalam fungsi `setupUsers()`, gantikan `TUKAR_SAYA` dengan kata laluan baharu (minimum 8 aksara).
   2. Pilih `setupUsers` dan klik **Run**.
   3. Tukar semula nilai itu kepada `TUKAR_SAYA` dan simpan, supaya kata laluan tidak kekal dalam kod.
3. **Deploy → Manage deployments** → edit deployment sedia ada → **Version: New version** → Deploy. Tetapan kekal: *Execute as: Me*, *Who has access: Anyone*. URL `/exec` kekal sama.
4. **Hentikan penerbitan CSV awam:** dalam Sheet, **File → Share → Publish to web → Stop publishing**. Pastikan Sheet tidak dikongsi "Anyone with the link".
5. Kemas kini `index.html`: di GitHub, atau dalam fail `index` projek Apps Script jika halaman dihos melalui `doGet`.

Untuk tukar kata laluan seorang pengguna kemudian, ulang langkah 2 dengan hanya akaun itu diisi. Untuk membuang akaun, jalankan `removeUser("ID")`.
