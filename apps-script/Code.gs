/**
 * ============================================================
 *  SISPAA JPN KEDAH — BACKEND GOOGLE APPS SCRIPT (v3)
 * ------------------------------------------------------------
 *  Prinsip teras:
 *   1. Satu NO KES = satu baris SAHAJA (upsert).
 *   2. LockService — satu permintaan tulis pada satu masa,
 *      supaya dua klik "Simpan" serentak TIDAK jadi dua baris.
 *   3. Carian header 'fuzzy' — tak kisah header ada ruang lebih
 *      atau susunan lajur berbeza, ia tetap padan.
 *   4. (v3) Log masuk & kawalan akses di PELAYAN:
 *      - Kata laluan disimpan sebagai hash dalam Script Properties
 *        (BUKAN dalam kod / HTML).
 *      - Setiap permintaan (kecuali LOGIN) mesti bawa TOKEN sesi.
 *      - Data (LIST) ditapis ikut PPD pengguna di pelayan.
 *      - PENGARAH/TIMBALAN baca sahaja; PPD hanya boleh ubah kes PPD sendiri.
 *   5. (v3) DELETE memindahkan baris ke sheet arkib (boleh dipulihkan).
 * ============================================================
 */

var SHEET_NAME = "Sheet1";            // <- tukar jika nama sheet pangkalan data berbeza
var ARCHIVE_SHEET_NAME = "Dipadam";   // baris yang dipadam dipindahkan ke sini

// Susunan lajur rasmi — hanya digunakan oleh setupSheets().
var HEADERS = [
  "TAHUN", "PPD", "PEGAWAI PENYIASAT", "NO KES", "ORANG YANG DIADU", "SEKOLAH",
  "BULAN", "TARIKH TERIMA", "TARIKH SELESAI", "TEMPOH SELESAI", "KES",
  "KATEGORI KES", "SUBKATEGORI", "KLASIFIKASI", "STATUS"
];

// Medan yang dibenarkan dikemas kini oleh METHOD = UPDATE
var UPDATE_FIELDS = ["STATUS", "KLASIFIKASI", "TARIKH SELESAI", "TEMPOH SELESAI", "KES"];

// Peranan peringkat negeri — nampak semua PPD
var STATE_ROLES = ["JPN", "PENGARAH", "TIMBALAN"];
// Peranan baca sahaja
var READONLY_ROLES = ["PENGARAH", "TIMBALAN"];

// Padanan nama PPD dalam data (lajur PPD) bagi setiap peranan daerah
var ROLE_ALIASES = {
  "PENDANG": ["PENDANG"],
  "KOTA SETAR": ["KOTA SETAR", "KOTA STAR"],
  "KUALA MUDA": ["KUALA MUDA", "KMY"],
  "YAN": ["YAN", "KMY"],
  "BALING": ["BALING"],
  "SIK": ["SIK"],
  "LANGKAWI": ["LANGKAWI"],
  "KUBANG PASU": ["KUBANG PASU", "KUBANGPASU"],
  "PADANG TERAP": ["PADANG TERAP", "PADANGTERAP"],
  "KULIM BANDAR BAHARU": ["KULIM", "BANDAR BAHARU", "BANDAR BARU", "KBB", "KULIMBANDAR BARU"]
};

var SESSION_TTL_SECONDS = 6 * 60 * 60; // 6 jam (had maksimum CacheService)
var MAX_LOGIN_ATTEMPTS = 5;             // cubaan gagal sebelum ID dikunci
var LOGIN_LOCKOUT_SECONDS = 15 * 60;    // tempoh kunci selepas terlalu banyak cubaan


/**
 * Hos fail index.html secara percuma di Web App.
 */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Portal SISPAA JPN')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/**
 * Pengendali utama permintaan POST daripada frontend.
 */
function doPost(e) {
  var params = (e && e.parameter) || {};
  var method = String(params.METHOD || "").toUpperCase();

  try {
    // ---------- LOGIN / LOGOUT (tiada token diperlukan untuk LOGIN) ----------
    if (method === "LOGIN") return jsonOut(handleLogin(params));
    if (method === "LOGOUT") {
      if (params.TOKEN) CacheService.getScriptCache().remove("tok_" + params.TOKEN);
      return jsonOut({ status: "success" });
    }

    // ---------- Semua kaedah lain memerlukan sesi sah ----------
    var session = getSession(params.TOKEN);
    if (!session) {
      return jsonOut({ status: "error", code: "SESSION_EXPIRED", message: "Sesi tamat atau tidak sah. Sila log masuk semula." });
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) {
      return jsonOut({ status: "error", message: "Sheet '" + SHEET_NAME + "' tidak dijumpai" });
    }

    if (method === "LIST") return jsonOut(handleList(sheet, session));

    if (method === "APPEND" || method === "UPDATE" || method === "DELETE") {
      if (READONLY_ROLES.indexOf(session.role) !== -1) {
        return jsonOut({ status: "error", code: "FORBIDDEN", message: "Akaun ini untuk paparan sahaja." });
      }
      return jsonOut(handleWrite(sheet, session, method, params));
    }

    return jsonOut({ status: "error", message: "METHOD tidak sah" });

  } catch (error) {
    return jsonOut({ status: "error", message: error.toString() });
  }
}


/* ===================== LOG MASUK & SESI ===================== */

function handleLogin(params) {
  var id = String(params.ID || "").trim().toUpperCase();
  var password = String(params.PASSWORD || "");
  if (!id || !password) return { status: "error", message: "ID dan kata laluan wajib diisi." };

  var cache = CacheService.getScriptCache();
  var attemptKey = "fail_" + id;
  var attempts = Number(cache.get(attemptKey) || 0);
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    return { status: "error", message: "Terlalu banyak cubaan gagal. Sila cuba semula selepas 15 minit." };
  }

  var users = getUsers();
  var user = users[id];
  if (!user || hashPassword(password, user.salt) !== user.hash) {
    cache.put(attemptKey, String(attempts + 1), LOGIN_LOCKOUT_SECONDS);
    return { status: "error", message: "ID Pengguna atau Kata Laluan tidak tepat. Sila semak semula." };
  }

  cache.remove(attemptKey);
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, "");
  cache.put("tok_" + token, JSON.stringify({ id: id, role: user.role }), SESSION_TTL_SECONDS);
  return { status: "success", token: token, role: user.role };
}

function getSession(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get("tok_" + token);
  return raw ? JSON.parse(raw) : null;
}

function getUsers() {
  var raw = PropertiesService.getScriptProperties().getProperty("USERS");
  return raw ? JSON.parse(raw) : {};
}

function hashPassword(password, salt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ":" + password, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
}

/**
 * Tetapkan / tukar kata laluan pengguna. Kata laluan disimpan sebagai hash
 * dalam Script Properties, bukan dalam kod.
 */
function setUserPassword(id, password, role) {
  id = String(id).trim().toUpperCase();
  if (!password || String(password).length < 8 || password === "TUKAR_SAYA") {
    throw new Error("Kata laluan untuk " + id + " mesti sekurang-kurangnya 8 aksara dan bukan 'TUKAR_SAYA'.");
  }
  if (STATE_ROLES.indexOf(role) === -1 && !ROLE_ALIASES[role]) {
    throw new Error("Peranan tidak dikenali: " + role);
  }
  var users = getUsers();
  var salt = Utilities.getUuid();
  users[id] = { salt: salt, hash: hashPassword(String(password), salt), role: role };
  PropertiesService.getScriptProperties().setProperty("USERS", JSON.stringify(users));
}

/**
 * Jalankan SEKALI dari editor Apps Script untuk menetapkan akaun.
 * 1. Gantikan setiap 'TUKAR_SAYA' dengan kata laluan BAHARU (min 8 aksara).
 * 2. Jalankan fungsi ini.
 * 3. Tukar semula kata laluan kepada 'TUKAR_SAYA' dan simpan, supaya
 *    kata laluan sebenar tidak kekal dalam kod.
 * Akaun bertanda 'TUKAR_SAYA' dilangkau (akaun sedia ada tidak berubah).
 */
function setupUsers() {
  var accounts = [
    ["ADMIN", "TUKAR_SAYA", "JPN"],
    ["PENGARAH", "TUKAR_SAYA", "PENGARAH"],
    ["TIMBALAN", "TUKAR_SAYA", "TIMBALAN"],
    ["PPDPENDANG", "TUKAR_SAYA", "PENDANG"],
    ["PPDKOTASETAR", "TUKAR_SAYA", "KOTA SETAR"],
    ["PPDKUALAMUDA", "TUKAR_SAYA", "KUALA MUDA"],
    ["PPDYAN", "TUKAR_SAYA", "YAN"],
    ["PPDBALING", "TUKAR_SAYA", "BALING"],
    ["PPDSIK", "TUKAR_SAYA", "SIK"],
    ["PPDLANGKAWI", "TUKAR_SAYA", "LANGKAWI"],
    ["PPDKUBANGPASU", "TUKAR_SAYA", "KUBANG PASU"],
    ["PPDPADANGTERAP", "TUKAR_SAYA", "PADANG TERAP"],
    ["PPDKULIMBANDARBARU", "TUKAR_SAYA", "KULIM BANDAR BAHARU"]
  ];
  var done = [];
  accounts.forEach(function (a) {
    if (a[1] === "TUKAR_SAYA") return;
    setUserPassword(a[0], a[1], a[2]);
    done.push(a[0]);
  });
  Logger.log("Akaun dikemas kini: " + (done.length ? done.join(", ") : "(tiada)"));
}

/** Padam akaun (cth. pegawai bertukar). Jalankan dari editor. */
function removeUser(id) {
  var users = getUsers();
  delete users[String(id).trim().toUpperCase()];
  PropertiesService.getScriptProperties().setProperty("USERS", JSON.stringify(users));
}


/* ===================== KAWALAN AKSES ===================== */

function isStateRole(role) {
  return STATE_ROLES.indexOf(role) !== -1;
}

// Sama seperti logik penapis asal di frontend (getBaseData)
function ppdMatchesRole(role, ppdValue) {
  if (isStateRole(role)) return true;
  var ppdStr = String(ppdValue || "").toUpperCase();
  var aliases = ROLE_ALIASES[role] || [role];
  return aliases.some(function (alias) { return ppdStr.indexOf(alias) !== -1; });
}


/* ===================== BACA DATA (LIST) ===================== */

function handleList(sheet, session) {
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return { status: "success", role: session.role, rows: [] };

  var headerRow = data[0].map(function (h) { return String(h).trim(); });
  var ppdCol = findCol(buildColumnIndex(headerRow), "PPD");
  var tz = Session.getScriptTimeZone();
  var rows = [];

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (r.every(function (v) { return v === "" || v === null; })) continue;
    if (ppdCol !== -1 && !ppdMatchesRole(session.role, r[ppdCol])) continue;
    if (ppdCol === -1 && !isStateRole(session.role)) continue;

    var obj = {};
    headerRow.forEach(function (h, idx) {
      if (!h) return;
      var v = r[idx];
      obj[h] = (Object.prototype.toString.call(v) === "[object Date]") ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : String(v == null ? "" : v);
    });
    rows.push(obj);
  }
  return { status: "success", role: session.role, rows: rows };
}


/* ===================== TULIS DATA ===================== */

function handleWrite(sheet, session, method, params) {
  var noKes = params["NO KES"];
  if (!noKes || String(noKes).trim() === "") {
    return { status: "error", message: "NO KES wajib diisi" };
  }

  var lock = LockService.getScriptLock();
  // Beratur — tunggu sehingga 30 saat untuk giliran menulis.
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return { status: "error", message: "Sistem sibuk menyimpan rekod lain. Sila cuba semula sebentar lagi." };
  }

  try {
    // Baca sekali sahaja — kita dalam kunci, jadi data ini stabil.
    var data      = sheet.getDataRange().getValues();
    var headerRow = data[0].map(function (h) { return String(h).trim(); });
    var colMap    = buildColumnIndex(headerRow);
    var noKesCol  = findCol(colMap, "NO KES");
    var ppdCol    = findCol(colMap, "PPD");

    if (noKesCol === -1) {
      return { status: "error", message: "Lajur 'NO KES' tiada pada header sheet" };
    }

    // Cari baris sedia ada — perbandingan dinormalkan supaya konsisten dgn frontend.
    var targetNorm  = normKes(noKes);
    var rowToUpdate = -1;
    for (var i = 1; i < data.length; i++) {
      if (normKes(data[i][noKesCol]) === targetNorm) {
        rowToUpdate = i + 1; // nombor baris sebenar (1-indexed)
        break;
      }
    }

    // Pegawai PPD hanya boleh menyentuh kes PPD sendiri
    if (rowToUpdate !== -1 && ppdCol !== -1 && !ppdMatchesRole(session.role, data[rowToUpdate - 1][ppdCol])) {
      return { status: "error", code: "FORBIDDEN", message: "Anda tiada akses kepada kes PPD lain." };
    }

    // ---------- APPEND (upsert penuh) ----------
    if (method === "APPEND") {
      if (!ppdMatchesRole(session.role, params["PPD"])) {
        return { status: "error", code: "FORBIDDEN", message: "PPD rekod mesti sama dengan PPD akaun anda." };
      }
      if (rowToUpdate !== -1) {
        // Wujud → kemas kini di tempat asal. Lajur tak berkaitan dikekalkan.
        writeRow(sheet, rowToUpdate, headerRow, params, data[rowToUpdate - 1]);
        return { status: "success", action: "updated", message: "Rekod sedia ada dikemas kini (tiada baris berganda)" };
      } else {
        // Belum wujud → tambah baris baharu di bawah.
        var newRowNum = sheet.getLastRow() + 1;
        writeRow(sheet, newRowNum, headerRow, params, null);
        return { status: "success", action: "appended", message: "Rekod baharu ditambah" };
      }
    }

    // ---------- UPDATE (medan terpilih sahaja) ----------
    if (method === "UPDATE") {
      if (rowToUpdate === -1) {
        return { status: "error", message: "NO KES tidak dijumpai di pangkalan data" };
      }
      UPDATE_FIELDS.forEach(function (field) {
        if (params[field] !== undefined) {
          var c = findCol(colMap, field);
          if (c !== -1) sheet.getRange(rowToUpdate, c + 1).setValue(safeCellValue(params[field]));
        }
      });
      return { status: "success", action: "updated", message: "Rekod dikemas kini" };
    }

    // ---------- DELETE (pindah ke sheet arkib) ----------
    if (method === "DELETE") {
      if (rowToUpdate === -1) {
        return { status: "error", message: "NO KES tidak dijumpai di pangkalan data" };
      }
      var archive = getArchiveSheet(headerRow);
      var archivedRow = data[rowToUpdate - 1].concat([new Date(), session.id]);
      archive.appendRow(archivedRow);
      sheet.deleteRow(rowToUpdate);
      return { status: "success", action: "deleted", message: "Rekod dipindahkan ke sheet '" + ARCHIVE_SHEET_NAME + "'" };
    }

    return { status: "error", message: "METHOD tidak sah" };

  } finally {
    lock.releaseLock(); // Wajib — lepaskan giliran untuk permintaan seterusnya.
  }
}

function getArchiveSheet(headerRow) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var archive = ss.getSheetByName(ARCHIVE_SHEET_NAME);
  if (!archive) {
    archive = ss.insertSheet(ARCHIVE_SHEET_NAME);
    archive.appendRow(headerRow.concat(["DIPADAM PADA", "DIPADAM OLEH"]));
    archive.setFrozenRows(1);
  }
  return archive;
}


/* ===================== FUNGSI PEMBANTU ===================== */

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Normalisasi NO KES: campurkan ruang lebihan jadi satu + huruf besar.
 * MESTI selaras dengan fungsi normKes() di frontend.
 */
function normKes(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Elak suntikan formula: teks bermula dengan = + - @ disimpan sebagai teks biasa
 * (nombor negatif seperti -3 tidak diubah).
 */
function safeCellValue(v) {
  var s = String(v == null ? "" : v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) return "'" + s;
  return v;
}

// Buang aksara bukan-alfanumerik untuk padanan nama lajur/param yang longgar.
function normHeader(h) {
  return String(h).replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

// Bina peta { NAMA_HEADER_NORM : indeks_lajur }
function buildColumnIndex(headerRow) {
  var map = {};
  headerRow.forEach(function (h, idx) { map[normHeader(h)] = idx; });
  return map;
}

function findCol(map, name) {
  var key = normHeader(name);
  return (map[key] !== undefined) ? map[key] : -1;
}

// Padankan satu header sheet dengan kunci param yang sepadan (fuzzy).
function matchParamKey(params, header) {
  var target = normHeader(header);
  var keys = Object.keys(params);
  for (var i = 0; i < keys.length; i++) {
    if (normHeader(keys[i]) === target) return keys[i];
  }
  return null;
}

/**
 * Tulis satu baris penuh mengikut kedudukan HEADER SEBENAR sheet.
 * - existingRow = array nilai baris asal (untuk kemas kini) atau null (baris baharu).
 * - Lajur yang tiada param sepadan: kekalkan nilai asal, atau kosong jika baris baharu.
 *   (Ini melindungi lajur tambahan spt "CATATAN" daripada terpadam.)
 */
function writeRow(sheet, rowNum, headerRow, params, existingRow) {
  var rowValues = headerRow.map(function (h, idx) {
    // Jangan sekali-kali tulis token / kaedah ke dalam sheet walaupun ada lajur senama
    var norm = normHeader(h);
    if (norm === "TOKEN" || norm === "METHOD" || norm === "PASSWORD") {
      return existingRow ? existingRow[idx] : "";
    }
    var key = matchParamKey(params, h);
    if (key !== null) return safeCellValue(params[key]);
    return existingRow ? existingRow[idx] : "";
  });
  sheet.getRange(rowNum, 1, 1, rowValues.length).setValues([rowValues]);
}

/**
 * Jalankan SEKALI secara manual (dari editor) untuk sediakan header
 * jika sheet masih kosong. Selamat — takkan tulis jika sudah ada data.
 */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
}
