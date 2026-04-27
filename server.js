const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const https = require('https');
const nodemailer = require('nodemailer'); 
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 5001);
const SUPPORT_CHAT_LIMIT = 3;
const SUPPORT_AGENT_ACTIVE_WINDOW_SECONDS = 15;
const CHAT_ATTACHMENT_DIR = path.join(__dirname, 'storage', 'chat_uploads');
const CHAT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
const ADMIN_EDITOR_ROOT = __dirname;
const ADMIN_EDITOR_ALLOWED_EXTENSIONS = new Set(['.html', '.js', '.json', '.css', '.md', '.txt', '.yml', '.yaml']);
const ADMIN_EDITOR_IGNORED_DIRS = new Set(['node_modules', '.git']);
const GITHUB_OAUTH_CONFIG = {
    clientId: process.env.GITHUB_CLIENT_ID || 'Ov23liUreJPrLvyaC6wr',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '62e1cd1854f6780fd2c529ecf87f2b83c25592fa',
    repo: process.env.GITHUB_REPO || 'persianking57/persianking57',
    baseUrl: (process.env.GITHUB_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, ''),
    scope: 'repo read:user'
};
const CHAT_ATTACHMENT_ALLOWED_TYPES = {
    'image/jpeg': { ext: '.jpg', kind: 'image', allowInline: true },
    'image/png': { ext: '.png', kind: 'image', allowInline: true },
    'image/webp': { ext: '.webp', kind: 'image', allowInline: true },
    'application/pdf': { ext: '.pdf', kind: 'file', allowInline: false }
};

process.on('uncaughtException', function (err) { console.error('Sistem Hatası Yakalandı:', err.message); });
process.on('unhandledRejection', function (reason, promise) { console.error('Promise Hatası Yakalandı:', reason); });

function normalizeAdminEditorPath(targetPath, options = {}) {
    const normalizedInput = String(targetPath || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
    if (!normalizedInput) throw new Error('invalid-file');
    const resolvedPath = path.resolve(ADMIN_EDITOR_ROOT, normalizedInput);
    const relativePath = path.relative(ADMIN_EDITOR_ROOT, resolvedPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw new Error('forbidden-file');
    const extension = path.extname(resolvedPath).toLowerCase();
    if (!options.skipExtensionCheck && extension && !ADMIN_EDITOR_ALLOWED_EXTENSIONS.has(extension)) throw new Error('invalid-file-type');
    return {
        inputPath: normalizedInput,
        relativePath: relativePath.replace(/\\/g, '/'),
        absolutePath: resolvedPath,
        extension
    };
}

function shouldExposeAdminEditorPath(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (!normalized || normalized === 'pro_sistem.db') return false;
    if (normalized.startsWith('storage/chat_uploads/')) return false;
    if (normalized.split('/').some(segment => ADMIN_EDITOR_IGNORED_DIRS.has(segment))) return false;
    const extension = path.extname(normalized).toLowerCase();
    return !extension || ADMIN_EDITOR_ALLOWED_EXTENSIONS.has(extension);
}

function collectAdminEditorFiles(currentDir, prefix = '') {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const files = [];
    entries.sort((left, right) => left.name.localeCompare(right.name, 'tr'));
    for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (ADMIN_EDITOR_IGNORED_DIRS.has(entry.name) || relativePath === 'storage/chat_uploads') continue;
            files.push(...collectAdminEditorFiles(path.join(currentDir, entry.name), relativePath));
            continue;
        }
        if (!shouldExposeAdminEditorPath(relativePath)) continue;
        files.push(relativePath);
    }
    return files;
}

app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(session({ secret: 'vip-crm-pro-v1', resave: false, saveUninitialized: false }));

const db = new sqlite3.Database('./pro_sistem.db');

fs.mkdirSync(CHAT_ATTACHMENT_DIR, { recursive: true });

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, ad TEXT, soyad TEXT, telefon TEXT, site_kullanici_adi TEXT, ip_adresi TEXT, konum TEXT, tarayıcı TEXT, cihaz TEXT, tarih DATETIME DEFAULT CURRENT_TIMESTAMP, is_archived INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS forum_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, ad TEXT, soyad TEXT, telefon TEXT, ulasim_tercihi TEXT, ip_adresi TEXT, konum TEXT, tarayici TEXT, cihaz TEXT, tarih DATETIME DEFAULT CURRENT_TIMESTAMP, is_archived INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS visitors (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT, konum TEXT, tarayici TEXT, cihaz TEXT, mac TEXT, visited_pages TEXT DEFAULT '[]', tarih DATETIME DEFAULT CURRENT_TIMESTAMP, is_archived INTEGER DEFAULT 0)`);
    db.run(`ALTER TABLE users ADD COLUMN os_name TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN device_model TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN device_details TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN user_agent TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN device_fingerprint TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN screen_resolution TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN browser_language TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN time_zone TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN referrer_url TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN network_type TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN cookie_status TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN storage_status TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN os_name TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN device_model TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN device_details TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN user_agent TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN device_fingerprint TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN screen_resolution TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN browser_language TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN time_zone TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN referrer_url TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN network_type TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN cookie_status TEXT`, () => {});
    db.run(`ALTER TABLE forum_requests ADD COLUMN storage_status TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN os_name TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN device_model TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN device_details TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN user_agent TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN screen_resolution TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN browser_language TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN time_zone TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN referrer_url TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN network_type TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN cookie_status TEXT`, () => {});
    db.run(`ALTER TABLE visitors ADD COLUMN storage_status TEXT`, () => {});
    db.run(`CREATE TABLE IF NOT EXISTS secure_settings (anahtar TEXT PRIMARY KEY, deger TEXT)`);
    db.run(`ALTER TABLE visitors ADD COLUMN device_fingerprint TEXT`, () => {});
    db.run(`CREATE TABLE IF NOT EXISTS banned_visitors (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT, device_fingerprint TEXT, ban_type TEXT, reason TEXT, created_by TEXT, tarih DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS visitor_messagebox_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_id INTEGER, device_fingerprint TEXT, title TEXT, message TEXT, message_type TEXT DEFAULT 'info', is_delivered INTEGER DEFAULT 0, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, delivered_at DATETIME)`);
    db.run(`CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, user_phone TEXT, user_subject TEXT, ip TEXT, device_fingerprint TEXT, mesajlar TEXT DEFAULT '[]', is_active INTEGER DEFAULT 1, tarih DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`ALTER TABLE chats ADD COLUMN assigned_admin TEXT`, () => {});
    db.run(`ALTER TABLE chats ADD COLUMN assigned_label TEXT`, () => {});
    db.run(`ALTER TABLE chats ADD COLUMN close_by TEXT`, () => {});
    db.run(`ALTER TABLE chats ADD COLUMN device_fingerprint TEXT`, () => {});
    db.run(`ALTER TABLE chats ADD COLUMN visitor_typing_at DATETIME`, () => {});
    db.run(`ALTER TABLE chats ADD COLUMN admin_typing_at DATETIME`, () => {});
    db.run(`ALTER TABLE chats ADD COLUMN assignment_status TEXT DEFAULT 'accepted'`, () => {});
    db.run(`ALTER TABLE chats ADD COLUMN rejected_admins TEXT DEFAULT '[]'`, () => {});
    db.run(`ALTER TABLE chats ADD COLUMN accepted_at DATETIME`, () => {});
    db.run(`CREATE TABLE IF NOT EXISTS chat_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, token TEXT UNIQUE, stored_name TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER DEFAULT 0, file_kind TEXT DEFAULT 'file', uploaded_by TEXT DEFAULT 'visitor', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS site_texts (anahtar TEXT PRIMARY KEY, deger TEXT)`);
    
    // ⚠️ KATEGORİ (SLIDER) TABLOSU DÜZELTİLDİ (Alt yazı ve renk sütunları eklendi)
    db.run(`CREATE TABLE IF NOT EXISTS custom_sliders (id INTEGER PRIMARY KEY AUTOINCREMENT, baslik TEXT, renk TEXT DEFAULT '#ffaa00', yazi TEXT DEFAULT '', model TEXT DEFAULT 'default')`);
    db.run(`ALTER TABLE custom_sliders ADD COLUMN renk TEXT DEFAULT '#ffaa00'`, (err) => {});
    db.run(`ALTER TABLE custom_sliders ADD COLUMN yazi TEXT DEFAULT ''`, (err) => {});
    db.run(`ALTER TABLE custom_sliders ADD COLUMN model TEXT DEFAULT 'default'`, (err) => {});

    // SPONSORLAR (OYUNLAR) TABLOSU
    db.run(`CREATE TABLE IF NOT EXISTS sponsors (id INTEGER PRIMARY KEY AUTOINCREMENT, isim TEXT, saglayici TEXT DEFAULT '', link TEXT, resimler TEXT, rtp TEXT, bilgi TEXT, slider_id INTEGER DEFAULT 0, auto_rtp INTEGER DEFAULT 0, auto_rtp_min REAL DEFAULT 70, auto_rtp_max REAL DEFAULT 99, auto_rtp_interval REAL DEFAULT 5, last_rtp_update INTEGER DEFAULT 0)`);
    db.run(`ALTER TABLE sponsors ADD COLUMN saglayici TEXT DEFAULT ''`, (err) => {});
    db.run(`ALTER TABLE sponsors ADD COLUMN auto_rtp INTEGER DEFAULT 0`, (err) => {}); 
    db.run(`ALTER TABLE sponsors ADD COLUMN auto_rtp_min REAL DEFAULT 70`, (err) => {}); 
    db.run(`ALTER TABLE sponsors ADD COLUMN auto_rtp_max REAL DEFAULT 99`, (err) => {});
    db.run(`ALTER TABLE sponsors ADD COLUMN auto_rtp_interval REAL DEFAULT 5`, (err) => {});
    db.run(`ALTER TABLE sponsors ADD COLUMN last_rtp_update INTEGER DEFAULT 0`, (err) => {}); 

    db.run(`CREATE TABLE IF NOT EXISTS settings (anahtar TEXT PRIMARY KEY, deger TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS menus (id INTEGER PRIMARY KEY AUTOINCREMENT, ad TEXT, link TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY AUTOINCREMENT, baslik TEXT, slug TEXT UNIQUE, icerik TEXT, resim_url TEXT, bg_color TEXT DEFAULT '#0a0a0c', box_color TEXT DEFAULT 'rgba(20,20,25,0.8)', bg_type TEXT DEFAULT 'color', bg_images TEXT, bg_effect TEXT DEFAULT 'fade', bg_speed TEXT DEFAULT '1000', bg_scale TEXT DEFAULT 'cover', bg_size_num TEXT DEFAULT '100', bg_size_unit TEXT DEFAULT '%', img_size TEXT DEFAULT '110', img_opacity TEXT DEFAULT '1', img_anim TEXT DEFAULT 'float', layout_json TEXT DEFAULT '[]', seo_title TEXT DEFAULT '', seo_description TEXT DEFAULT '', seo_keywords TEXT DEFAULT '', seo_image TEXT DEFAULT '', seo_canonical TEXT DEFAULT '', seo_noindex INTEGER DEFAULT 0)`);
    db.run(`ALTER TABLE pages ADD COLUMN layout_json TEXT DEFAULT '[]'`, () => {});
    db.run(`ALTER TABLE pages ADD COLUMN seo_title TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE pages ADD COLUMN seo_description TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE pages ADD COLUMN seo_keywords TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE pages ADD COLUMN seo_image TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE pages ADD COLUMN seo_canonical TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE pages ADD COLUMN seo_noindex INTEGER DEFAULT 0`, () => {});
    db.run(`CREATE TABLE IF NOT EXISTS footer_items (id INTEGER PRIMARY KEY AUTOINCREMENT, tip TEXT, icerik TEXT, renk TEXT, link_url TEXT, hedef TEXT DEFAULT '_self')`);
    db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, islem TEXT, admin_user TEXT, ip_adresi TEXT, cihaz_bilgisi TEXT, tarih DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, risk_level TEXT, method TEXT, request_path TEXT, query_text TEXT, payload_excerpt TEXT, ip_adresi TEXT, user_agent TEXT, cihaz_bilgisi TEXT, detection_reason TEXT, tarih DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT, perms TEXT, display_name TEXT, session_version INTEGER DEFAULT 0, force_logout_message TEXT DEFAULT '')`);
    db.run(`ALTER TABLE admins ADD COLUMN display_name TEXT`, () => {});
    db.run(`ALTER TABLE admins ADD COLUMN session_version INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE admins ADD COLUMN force_logout_message TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE admins ADD COLUMN last_seen DATETIME`, () => {});
    db.run(`ALTER TABLE admins ADD COLUMN support_active INTEGER DEFAULT 1`, () => {});
    db.run(`UPDATE admins SET display_name = username WHERE display_name IS NULL OR TRIM(display_name) = ''`);
    db.run(`UPDATE admins SET support_active = 1 WHERE support_active IS NULL`);
    db.run(`CREATE TABLE IF NOT EXISTS support_team_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_username TEXT NOT NULL, admin_label TEXT NOT NULL, message TEXT NOT NULL, attachment_json TEXT DEFAULT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`ALTER TABLE support_team_messages ADD COLUMN attachment_json TEXT DEFAULT NULL`, () => {});
    db.run(`CREATE TABLE IF NOT EXISTS support_team_message_archives (id INTEGER PRIMARY KEY AUTOINCREMENT, original_message_id INTEGER, admin_username TEXT NOT NULL, admin_label TEXT NOT NULL, message TEXT NOT NULL, attachment_json TEXT DEFAULT NULL, created_at DATETIME, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT NOT NULL, deleted_by_label TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS support_team_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, token TEXT UNIQUE, stored_name TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER DEFAULT 0, file_kind TEXT DEFAULT 'file', uploaded_by TEXT DEFAULT 'admin', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    db.get("SELECT COUNT(*) as count FROM admins", (err, row) => { if (row && row.count === 0) { db.run(`INSERT INTO admins (username, password, role, perms, display_name) VALUES ('admin', '123456', 'superadmin', '[]', 'admin')`); } });

    const defaults = [
        ['logo_text', 'VIPSLOT'], ['logo_url', 'https://img.icons8.com/color/48/crown.png'], ['hero_title', 'VIP RTP Analiz Sistemi'], ['hero_title_color', '#ffffff'],
        ['hero_subtitle', 'En yüksek oranlı masaları anlık takip edin.'], ['hero_sub_color', '#aaaaaa'], ['hero_image', 'https://img.icons8.com/fluency/200/rocket.png'], ['tema_gold', '#ffaa00'],
        ['duyuru_metni', 'Sistem Aktif! Bol Şanslar.'], ['duyuru_bg', '#ffaa00'], ['duyuru_color', '#000000'], ['analiz_title', 'CANLI RTP ANALİZLERİ'], ['analiz_subtitle', 'Sistemimize entegre olan oyunların anlık RTP oranları...'], ['analiz_image', 'https://img.icons8.com/fluency/200/combo-chart.png'],
        ['footer_copy', '2026 VIPSLOT All Rights Reserved.'], ['footer_bg', '#0a0a0c'], ['page_box_width', '1200'], ['form_redirect', '/analizler'], ['rtp_interval_unit', 'minute'],
        ['g_bg_type', 'color'], ['g_bg_color', '#0a0a0c'], ['g_bg_images', ''], ['g_bg_effect', 'fade'], ['g_bg_speed', '1500'], ['g_bg_scale', 'cover'], ['g_bg_size_num', '100'], ['g_bg_size_unit', '%'],
        ['index_bg_type', 'color'], ['index_bg_color', '#0a0a0c'], ['index_bg_images', ''], ['index_bg_effect', 'fade'], ['index_bg_speed', '1500'], ['index_bg_scale', 'cover'], ['index_bg_size_num', '100'], ['index_bg_size_unit', '%'], ['index_box_color', 'rgba(20,20,25,0.7)'], ['index_img_size', '140'], ['index_img_opacity', '1'], ['index_img_anim', 'float'], ['index_layout_json', '[]'],
        ['analiz_bg_type', 'color'], ['analiz_bg_color', '#0a0a0c'], ['analiz_bg_images', ''], ['analiz_bg_effect', 'fade'], ['analiz_bg_speed', '1500'], ['analiz_bg_scale', 'cover'], ['analiz_bg_size_num', '100'], ['analiz_bg_size_unit', '%'], ['analiz_box_color', 'rgba(20,20,25,0.6)'], ['analiz_img_size', '120'], ['analiz_img_opacity', '1'], ['analiz_img_anim', 'float'], ['analiz_layout_json', '[]'],
        ['forum_title', 'VIP FORUM'], ['forum_intro', 'Forum alanindan temel bilgilerinizi birakin. Ekip sizi tercih ettiginiz kanaldan kisa surede donsun.'], ['forum_image', ''], ['forum_bg_type', 'color'], ['forum_bg_color', '#0a0a0c'], ['forum_bg_images', ''], ['forum_bg_effect', 'fade'], ['forum_bg_speed', '1500'], ['forum_bg_scale', 'cover'], ['forum_bg_size_num', '100'], ['forum_bg_size_unit', '%'], ['forum_box_color', 'rgba(20,20,25,0.78)'], ['forum_img_size', '120'], ['forum_img_opacity', '1'], ['forum_img_anim', 'float'], ['forum_layout_json', '[]'], ['forum_form_title', 'Forum Formu'], ['forum_form_intro', 'Bilgilerinizi doldurun ve hangi kanaldan donus istediginizi secin.'], ['forum_placeholder_name', 'Adiniz'], ['forum_placeholder_surname', 'Soyadiniz'], ['forum_placeholder_phone', '05xx xxx xx xx'], ['forum_submit_text', 'VIP FORUMA GONDER'], ['forum_clear_text', 'TEMIZLE'], ['forum_option_call_label', 'Telefonla Arama'], ['forum_option_call_desc', 'Temsilci sizi dogrudan telefonla arasin ve hizlica bilgi versin.'], ['forum_option_whatsapp_label', 'WhatsApp\'tan Ulasmak'], ['forum_option_whatsapp_desc', 'Temsilci size WhatsApp uzerinden yazsin, yazili iletisimle ilerleyin.'],
        ['whatsapp_no', '+905555555555'], ['live_chat_active', 'true'], ['blur_games', 'true'],
        ['rtp_random_active', 'false'], ['rtp_min', '70'], ['rtp_max', '99'], ['rtp_interval', '5'],
        ['site_favicon', ''], ['chat_agent_name', 'Müşteri Temsilcisi'], ['admin_favicon', ''],
        ['maintenance_mode', '0'], ['maintenance_title', 'Site Gecici Olarak Bakimda'], ['maintenance_message', 'Altyapi calismasi nedeniyle site su anda ziyaretcilere kapatildi. Lutfen daha sonra tekrar deneyin.'],
        ['seo_base_url', ''], ['seo_site_name', 'VIP'], ['seo_default_title', 'VIP'], ['seo_default_description', 'VIP icerik platformu'], ['seo_default_keywords', 'vip, analiz, forum'], ['seo_default_image', ''],
        ['index_seo_title', ''], ['index_seo_description', ''], ['index_seo_keywords', ''], ['index_seo_image', ''], ['index_seo_canonical', ''], ['index_seo_noindex', '0'],
        ['analizler_seo_title', ''], ['analizler_seo_description', ''], ['analizler_seo_keywords', ''], ['analizler_seo_image', ''], ['analizler_seo_canonical', ''], ['analizler_seo_noindex', '0'],
        ['forum_seo_title', ''], ['forum_seo_description', ''], ['forum_seo_keywords', ''], ['forum_seo_image', ''], ['forum_seo_canonical', ''], ['forum_seo_noindex', '0']
    ];
    defaults.forEach(s => db.run(`INSERT OR IGNORE INTO settings (anahtar, deger) VALUES (?, ?)`, s));
    
    const defaultTexts = [
        ['placeholder_ad', 'Adınız'], ['placeholder_soyad', 'Soyadınız'], ['placeholder_tel', 'Telefon Numaranız'],
        ['placeholder_kadi', 'Site Kullanıcı Adınız'], ['btn_analiz', 'ANALİZİ BAŞLAT'], ['txt_blur_warning', 'Oyunlardaki RTP oranlarını görmek için bilgileri girin.'], ['index_bg_photo', '']
    ];
    defaultTexts.forEach(t => db.run(`INSERT OR IGNORE INTO site_texts (anahtar, deger) VALUES (?, ?)`, t));
    db.run(
        `UPDATE site_texts SET deger = ? WHERE anahtar = 'txt_blur_warning' AND (TRIM(deger) = ? OR TRIM(deger) = ? OR TRIM(deger) = ?)`,
        ['Oyunlardaki RTP oranlarını görmek için bilgileri girin.', 'Oyunları görmek için formu doldurun.', 'Oyunları görmek için bilgileri girin.', 'Oyunlarda ki RTP oranlarını görmek için bilgileri girin']
    );
    db.get("SELECT COUNT(*) as count FROM menus", (err, row) => { if (row && row.count === 0) db.run(`INSERT INTO menus (ad, link) VALUES ('ANALİZLER', '/analizler')`); });
    db.get(`SELECT COUNT(*) as count FROM menus WHERE link = '/forum'`, (err, row) => { if (row && row.count === 0) db.run(`INSERT INTO menus (ad, link) VALUES ('VIP FORUM', '/forum')`); else db.run(`UPDATE menus SET ad = 'VIP FORUM' WHERE link = '/forum'`); });
});

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const rawIp = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || req.socket.remoteAddress || 'Bilinmiyor').split(',')[0].trim();
    if (rawIp === '::1') return '127.0.0.1';
    return rawIp || 'Bilinmiyor';
}

const geoLocationCache = new Map();

function isPrivateIp(ip) {
    const value = String(ip || '').trim();
    return value === '127.0.0.1'
        || value === '::1'
        || /^10\./.test(value)
        || /^192\.168\./.test(value)
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value)
        || /^::ffff:127\./i.test(value)
        || /^::ffff:10\./i.test(value)
        || /^::ffff:192\.168\./i.test(value)
        || /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./i.test(value);
}

async function resolveLocationFromIp(ip) {
    const normalizedIp = String(ip || '').trim();
    if (!normalizedIp || normalizedIp === 'Bilinmiyor') return 'Bilinmiyor';
    if (isPrivateIp(normalizedIp)) return 'Yerel Ag';
    if (geoLocationCache.has(normalizedIp)) return geoLocationCache.get(normalizedIp);
    try {
        const response = await axios.get(`https://ipwho.is/${encodeURIComponent(normalizedIp)}`, { timeout: 3500 });
        const data = response?.data || {};
        if (!data.success) return 'Bilinmiyor';
        const parts = [data.city, data.region, data.country].map(part => String(part || '').trim()).filter(Boolean);
        const location = parts.length > 0 ? parts.join(' / ') : 'Bilinmiyor';
        geoLocationCache.set(normalizedIp, location);
        return location;
    } catch (e) {
        return 'Bilinmiyor';
    }
}

function getBrowserName(userAgent) {
    const ua = String(userAgent || '');
    if (/(Edg\/|EdgA\/|EdgiOS\/|Edge\/)/i.test(ua)) return 'Edge';
    if (/Firefox\//i.test(ua)) return 'Firefox';
    if (/(Chrome\/|CriOS\/)/i.test(ua) && !/(Edg\/|EdgA\/|EdgiOS\/|Edge\/|OPR\/)/i.test(ua)) return 'Chrome';
    if (/Safari\//i.test(ua) && !/(Chrome\/|CriOS\/|Edg\/|EdgA\/|EdgiOS\/|Edge\/)/i.test(ua)) return 'Safari';
    return 'Diğer';
}

function getBrowserVersion(userAgent) {
    const patterns = [
        { name: 'Edge', regex: /Edge\/([\d.]+)/i },
        { name: 'Edge', regex: /Edg\/([\d.]+)/i },
        { name: 'Edge', regex: /EdgA\/([\d.]+)/i },
        { name: 'Edge', regex: /EdgiOS\/([\d.]+)/i },
        { name: 'Chrome', regex: /CriOS\/([\d.]+)/i },
        { name: 'Chrome', regex: /Chrome\/([\d.]+)/i },
        { name: 'Firefox', regex: /Firefox\/([\d.]+)/i },
        { name: 'Safari', regex: /Version\/([\d.]+).*Safari/i }
    ];
    for (const item of patterns) {
        const match = String(userAgent || '').match(item.regex);
        if (match?.[1]) return `${item.name} ${match[1]}`;
    }
    return getBrowserName(userAgent);
}

function getDeviceName(userAgent) {
    if (userAgent.includes('iPhone')) return 'iPhone';
    if (userAgent.includes('iPad')) return 'iPad';
    if (userAgent.includes('Android')) return 'Android';
    if (userAgent.includes('Macintosh')) return 'Mac';
    return 'PC';
}

function getOsName(userAgent) {
    const ua = String(userAgent || '');
    if (/Windows NT 10\.0/i.test(ua)) return 'Windows 10/11';
    if (/Windows NT 6\.3/i.test(ua)) return 'Windows 8.1';
    if (/Windows NT 6\.2/i.test(ua)) return 'Windows 8';
    if (/Windows NT 6\.1/i.test(ua)) return 'Windows 7';
    if (/Android ([\d.]+)/i.test(ua)) return `Android ${ua.match(/Android ([\d.]+)/i)?.[1] || ''}`.trim();
    if (/iPhone OS ([\d_]+)/i.test(ua)) return `iOS ${String(ua.match(/iPhone OS ([\d_]+)/i)?.[1] || '').replace(/_/g, '.')}`.trim();
    if (/iPad; CPU OS ([\d_]+)/i.test(ua)) return `iPadOS ${String(ua.match(/iPad; CPU OS ([\d_]+)/i)?.[1] || '').replace(/_/g, '.')}`.trim();
    if (/Mac OS X ([\d_]+)/i.test(ua)) return `macOS ${String(ua.match(/Mac OS X ([\d_]+)/i)?.[1] || '').replace(/_/g, '.')}`.trim();
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Bilinmiyor';
}

function getDeviceModel(userAgent) {
    const ua = String(userAgent || '');
    const patterns = [
        /iPhone/,
        /iPad/,
        /Pixel\s([\w\s-]+)/i,
        /SM-([A-Z0-9]+)/i,
        /Redmi\s([\w\s-]+)/i,
        /Mi\s([\w\s-]+)/i,
        /MIX\s([\w\s-]+)/i,
        /ONEPLUS\s([A-Z0-9]+)/i,
        /CPH([A-Z0-9]+)/i,
        /V(\d{4}[A-Z0-9]*)/i,
        /HUAWEI\s([\w-]+)/i,
        /HONOR\s([\w-]+)/i,
        /Moto\s([\w\s-]+)/i,
        /Nokia\s([\w\s-]+)/i
    ];
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    for (const pattern of patterns) {
        const match = ua.match(pattern);
        if (!match) continue;
        if (pattern.source === 'SM-([A-Z0-9]+)') return `Samsung SM-${match[1]}`;
        if (pattern.source === 'CPH([A-Z0-9]+)') return `OPPO CPH${match[1]}`;
        if (pattern.source === 'V(\\d{4}[A-Z0-9]*)') return `vivo V${match[1]}`;
        if (match[1]) return match[0].trim();
        return match[0].trim();
    }
    return '';
}

function getDeviceType(userAgent) {
    const ua = String(userAgent || '');
    if (/Tablet|iPad/i.test(ua)) return 'Tablet';
    if (/Mobile|iPhone|Android/i.test(ua)) return 'Mobil';
    if (/Macintosh|Windows|Linux/i.test(ua)) return 'Masaüstü';
    return 'Bilinmiyor';
}

function getCpuArch(userAgent) {
    const ua = String(userAgent || '');
    if (/arm64|aarch64/i.test(ua)) return 'ARM64';
    if (/x86_64|Win64|WOW64|amd64|x64/i.test(ua)) return 'x64';
    if (/i686|i386|x86/i.test(ua)) return 'x86';
    return 'Bilinmiyor';
}

function buildDeviceDetails(meta) {
    return [
        meta.deviceType ? `Tür: ${meta.deviceType}` : '',
        meta.osName && meta.osName !== 'Bilinmiyor' ? `OS: ${meta.osName}` : '',
        meta.deviceModel ? `Model: ${meta.deviceModel}` : '',
        meta.browserVersion ? `Tarayıcı: ${meta.browserVersion}` : '',
        meta.cpuArch && meta.cpuArch !== 'Bilinmiyor' ? `Mimari: ${meta.cpuArch}` : ''
    ].filter(Boolean).join(' | ');
}

function normalizeDeviceFingerprint(value) {
    return String(value || '').trim().slice(0, 255);
}

function normalizeClientField(value, maxLength = 255) {
    return String(value || '').trim().slice(0, maxLength);
}

function getClientEnvironment(req) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    return {
        screenResolution: normalizeClientField(body.screenResolution, 80),
        browserLanguage: normalizeClientField(body.browserLanguage, 120),
        timeZone: normalizeClientField(body.timeZone, 120),
        referrerUrl: normalizeClientField(body.referrerUrl, 500),
        networkType: normalizeClientField(body.networkType, 120),
        cookieStatus: normalizeClientField(body.cookieStatus, 120),
        storageStatus: normalizeClientField(body.storageStatus, 120)
    };
}

function getClientFingerprint(req) {
    const bodyFingerprint = req.body && typeof req.body === 'object' ? req.body.deviceFingerprint : '';
    return normalizeDeviceFingerprint(bodyFingerprint || req.headers['x-device-fingerprint'] || req.cookies?.device_fp || '');
}

function getClientContext(req) {
    const userAgent = req.headers['user-agent'] || '';
    const deviceModel = getDeviceModel(userAgent);
    const osName = getOsName(userAgent);
    const browserVersion = getBrowserVersion(userAgent);
    const deviceType = getDeviceType(userAgent);
    const cpuArch = getCpuArch(userAgent);
    const environment = getClientEnvironment(req);
    return {
        ip: getClientIp(req),
        userAgent,
        browser: getBrowserName(userAgent),
        browserVersion,
        device: deviceModel || getDeviceName(userAgent),
        deviceModel,
        osName,
        deviceType,
        cpuArch,
        deviceDetails: buildDeviceDetails({ deviceType, osName, deviceModel, browserVersion, cpuArch }),
        deviceFingerprint: getClientFingerprint(req),
        screenResolution: environment.screenResolution,
        browserLanguage: environment.browserLanguage,
        timeZone: environment.timeZone,
        referrerUrl: environment.referrerUrl,
        networkType: environment.networkType,
        cookieStatus: environment.cookieStatus,
        storageStatus: environment.storageStatus
    };
}

function setDeviceFingerprintCookie(res, deviceFingerprint) {
    if (!deviceFingerprint) return;
    res.cookie('device_fp', deviceFingerprint, { maxAge: 1000 * 60 * 60 * 24 * 365, sameSite: 'lax' });
}

function createPayloadSnippet(value, maxLength = 700) {
    if (value == null) return '';
    let text = '';
    if (typeof value === 'string') text = value;
    else {
        try {
            text = JSON.stringify(value);
        } catch (e) {
            text = String(value);
        }
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizePhoneNumber(value) {
    return String(value || '').trim().slice(0, 30);
}

function phoneNumberHasLetters(value) {
    return /[A-Za-zÇĞİIÖŞÜçğıiöşü]/.test(String(value || ''));
}

function shouldInspectSecurityEvent(req) {
    const requestPath = String(req.path || '').toLowerCase();
    if (req.session?.isAdmin) return false;
    if (requestPath === '/favicon.ico') return false;
    if (requestPath.startsWith('/api/admin')) return false;
    if (/\.(css|js|mjs|png|jpg|jpeg|gif|svg|ico|webp|avif|woff2?|ttf|map)$/i.test(requestPath)) return false;
    return true;
}

function detectSecurityEvent(req) {
    if (!shouldInspectSecurityEvent(req)) return null;

    const requestPath = String(req.path || '').trim();
    const normalizedPath = requestPath.toLowerCase();
    const queryText = String(req.originalUrl || '').split('?')[1] || '';
    const payloadExcerpt = createPayloadSnippet(req.body);
    const userAgent = String(req.headers['user-agent'] || '').trim();
    const targetText = [normalizedPath, queryText.toLowerCase(), payloadExcerpt.toLowerCase()].filter(Boolean).join(' ');
    const reasons = [];
    let eventType = 'probe';
    let riskLevel = 'medium';

    const suspiciousPathTokens = [
        '.env', '.git', 'wp-admin', 'wp-login', 'xmlrpc.php', 'phpmyadmin', 'adminer',
        'vendor/phpunit', 'boaform', 'cgi-bin', 'server-status', 'autodiscover',
        '.aws', 'jenkins', 'actuator', 'owa', 'laravel', 'wordpress', '.sql', '.bak',
        'backup', 'dump', 'database', 'shell', 'passwd', 'config.php', 'id_rsa'
    ];
    const matchedPathToken = suspiciousPathTokens.find(token => normalizedPath.includes(token));
    if (matchedPathToken) {
        reasons.push(`Supheli hedef yolu: ${matchedPathToken}`);
        eventType = 'path-scan';
        riskLevel = 'high';
    }

    const scannerAgents = [
        'sqlmap', 'nikto', 'nmap', 'masscan', 'acunetix', 'nessus', 'openvas', 'wpscan',
        'dirbuster', 'gobuster', 'ffuf', 'burpsuite', 'arachni', 'zgrab', 'jaeles'
    ];
    const matchedScannerAgent = scannerAgents.find(agent => userAgent.toLowerCase().includes(agent));
    if (matchedScannerAgent) {
        reasons.push(`Tarama araci user-agent: ${matchedScannerAgent}`);
        eventType = eventType === 'probe' ? 'scanner-probe' : eventType;
    }

    if (['TRACE', 'TRACK', 'CONNECT', 'DEBUG'].includes(String(req.method || '').toUpperCase())) {
        reasons.push(`Riskli HTTP metodu: ${String(req.method || '').toUpperCase()}`);
        eventType = 'risky-method';
    }

    const attackPatterns = [
        { regex: /(union\s+select|select\s+.+from|information_schema|sleep\(|benchmark\(|or\s+1=1|drop\s+table|into\s+outfile|load_file\()/i, reason: 'SQL injection paterni', level: 'high', type: 'payload-attack' },
        { regex: /(<script\b|javascript:|onerror\s*=|onload\s*=|document\.cookie|alert\s*\()/i, reason: 'XSS paterni', level: 'high', type: 'payload-attack' },
        { regex: /(\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e\\|%252e%252e)/i, reason: 'Path traversal paterni', level: 'high', type: 'payload-attack' },
        { regex: /(php:\/\/|data:text\/html|expect:\/\/|file:\/\/|\/etc\/passwd|boot\.ini)/i, reason: 'Dosya erisimi/LFI paterni', level: 'high', type: 'payload-attack' },
        { regex: /(;|\|\||&&)\s*(cat|ls|id|wget|curl|powershell|bash|sh)\b/i, reason: 'Komut enjeksiyonu paterni', level: 'high', type: 'payload-attack' }
    ];
    attackPatterns.forEach(pattern => {
        if (pattern.regex.test(targetText)) {
            reasons.push(pattern.reason);
            eventType = pattern.type;
            riskLevel = pattern.level;
        }
    });

    if (reasons.length === 0) return null;
    if (reasons.length >= 2) riskLevel = 'high';

    return {
        eventType,
        riskLevel,
        requestPath: requestPath || '/',
        queryText: queryText.slice(0, 500),
        payloadExcerpt,
        userAgent: userAgent.slice(0, 400),
        detectionReason: reasons.join(' | ').slice(0, 600)
    };
}

function logSecurityEvent(req, event) {
    if (!event) return;
    const context = getClientContext(req);
    const ip = context.ip;
    const deviceInfo = `${context.device} / ${context.browser}`;
    db.get(
        `SELECT id FROM security_events
         WHERE ip_adresi = ? AND method = ? AND request_path = ? AND detection_reason = ?
           AND tarih >= datetime('now', '-5 minutes')
         ORDER BY id DESC LIMIT 1`,
        [ip, req.method, event.requestPath, event.detectionReason],
        (err, row) => {
            if (err || row) return;
            db.run(
                `INSERT INTO security_events (event_type, risk_level, method, request_path, query_text, payload_excerpt, ip_adresi, user_agent, cihaz_bilgisi, detection_reason) VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [event.eventType, event.riskLevel, req.method, event.requestPath, event.queryText, event.payloadExcerpt, ip, event.userAgent, deviceInfo, event.detectionReason]
            );
        }
    );
}

function buildClientSecurityEvent(req) {
    if (req.session?.isAdmin) return null;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const requestedEventType = normalizeClientField(body.eventType, 80).toLowerCase();
    const shortcut = normalizeClientField(body.shortcut, 40);
    const pageTitle = normalizeClientField(body.pageTitle, 200);
    const pagePath = normalizeClientField(body.pagePath, 250) || '/';
    const signal = normalizeClientField(body.signal, 80);
    if (!shortcut) return null;
    if (requestedEventType === 'blocked-shortcut') {
        const payloadParts = [shortcut ? `Kisayol: ${shortcut}` : '', pageTitle ? `Baslik: ${pageTitle}` : ''].filter(Boolean);
        return {
            eventType: 'blocked-shortcut',
            riskLevel: 'medium',
            requestPath: pagePath,
            queryText: '',
            payloadExcerpt: payloadParts.join(' | ').slice(0, 500),
            userAgent: String(req.headers['user-agent'] || '').trim().slice(0, 400),
            detectionReason: `Engellenen kaynak goruntuleme kisayolu denemesi (${shortcut})`.slice(0, 600)
        };
    }
    if (requestedEventType === 'screenshot-capture') {
        const payloadParts = [shortcut ? `Kisayol: ${shortcut}` : '', pageTitle ? `Baslik: ${pageTitle}` : ''].filter(Boolean);
        return {
            eventType: 'screenshot-capture',
            riskLevel: 'medium',
            requestPath: pagePath,
            queryText: '',
            payloadExcerpt: payloadParts.join(' | ').slice(0, 500),
            userAgent: String(req.headers['user-agent'] || '').trim().slice(0, 400),
            detectionReason: `Ekran goruntusu alma girisimi algilandi (${shortcut})`.slice(0, 600)
        };
    }
    if (requestedEventType === 'mobile-screenshot-suspected') {
        const payloadParts = [shortcut ? `Kisayol: ${shortcut}` : '', signal ? `Sinyal: ${signal}` : '', pageTitle ? `Baslik: ${pageTitle}` : ''].filter(Boolean);
        return {
            eventType: 'mobile-screenshot-suspected',
            riskLevel: 'low',
            requestPath: pagePath,
            queryText: '',
            payloadExcerpt: payloadParts.join(' | ').slice(0, 500),
            userAgent: String(req.headers['user-agent'] || '').trim().slice(0, 400),
            detectionReason: `Mobil cihazda ekran goruntusu supheli davranisi algilandi (${shortcut}${signal ? ` / ${signal}` : ''})`.slice(0, 600)
        };
    }
    return null;
}

function findVisitorByContext(context, callback) {
    const fingerprint = normalizeDeviceFingerprint(context.deviceFingerprint);
    if (fingerprint) {
        return db.get(
            `SELECT *
             FROM visitors
             WHERE is_archived = 0 AND device_fingerprint = ?
             ORDER BY id DESC
             LIMIT 1`,
            [fingerprint],
            (err, row) => {
                if (err || row) return callback(err, row);
                db.get(
                    `SELECT *
                     FROM visitors
                     WHERE is_archived = 0
                       AND ip = ?
                       AND user_agent = ?
                       AND (TRIM(COALESCE(device_fingerprint, '')) = '' OR device_fingerprint IS NULL)
                     ORDER BY id DESC
                     LIMIT 1`,
                    [context.ip, context.userAgent || ''],
                    (fallbackErr, fallbackRow) => callback(fallbackErr, fallbackRow)
                );
            }
        );
    }
    db.get(
        `SELECT *
         FROM visitors
         WHERE is_archived = 0 AND ip = ? AND user_agent = ?
         ORDER BY id DESC
         LIMIT 1`,
        [context.ip, context.userAgent || ''],
        (err, row) => callback(err, row)
    );
}

function findBanByContext(context, callback) {
    const deviceFingerprint = context.deviceFingerprint || '__no_device__';
    db.get(
        `SELECT * FROM banned_visitors
         WHERE (TRIM(COALESCE(ip, '')) != '' AND ip = ?)
            OR (TRIM(COALESCE(device_fingerprint, '')) != '' AND device_fingerprint = ?)
         ORDER BY id DESC LIMIT 1`,
        [context.ip, deviceFingerprint],
        (err, row) => callback(err, row)
    );
}

function sendBanResponse(req, res, banRow) {
    const reason = banRow?.reason || 'Bu cihaz veya IP adresi engellenmiştir.';
    const acceptsHtml = (req.headers.accept || '').includes('text/html');
    if (req.method === 'GET' && acceptsHtml) {
        return res.status(403).send(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Erişim Engellendi</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090d;color:#fff;font-family:'Segoe UI',sans-serif;padding:24px} .box{max-width:560px;background:#111118;border:1px solid #ff4444;border-radius:20px;padding:32px;box-shadow:0 25px 60px rgba(0,0,0,.45)} h1{margin:0 0 14px;color:#ffaa00;font-size:30px} p{margin:0;color:#c9c9d2;line-height:1.6} .meta{margin-top:18px;color:#ff8080;font-weight:700}</style></head><body><div class="box"><h1>Erişim Engellendi</h1><p>${reason}</p><div class="meta">Destek için site yönetimi ile iletişime geçin.</div></div></body></html>`);
    }
    return res.status(403).json({ status: 'banned', msg: reason });
}

function sendMaintenanceResponse(req, res, settingsMap) {
    const title = escapeHtml(String(settingsMap.maintenance_title || 'Site Gecici Olarak Bakimda').trim());
    const message = escapeHtml(String(settingsMap.maintenance_message || 'Altyapi calismasi nedeniyle site su anda ziyaretcilere kapatildi. Lutfen daha sonra tekrar deneyin.').trim());
    const isApiRequest = req.path.startsWith('/api/');
    if (isApiRequest) {
        return res.status(503).json({ status: 'maintenance', msg: message });
    }
    return res.status(503).send(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top, rgba(255,170,0,0.16), transparent 28%), #07080c;color:#fff;font-family:'Segoe UI',sans-serif;padding:24px}.box{max-width:640px;background:rgba(12,13,18,0.94);border:1px solid rgba(255,170,0,0.28);border-radius:24px;padding:36px;box-shadow:0 28px 70px rgba(0,0,0,.5)}.badge{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;background:rgba(255,170,0,.12);border:1px solid rgba(255,170,0,.2);color:#ffaa00;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px}h1{margin:18px 0 12px;font-size:34px;line-height:1.15}p{margin:0;color:#c6cad4;line-height:1.8;font-size:16px}.sub{margin-top:18px;color:#8f95a5;font-size:13px}</style></head><body><div class="box"><div class="badge">Bakim Modu Aktif</div><h1>${title}</h1><p>${message}</p><div class="sub">Calisma tamamlandiginda site yeniden acilacaktir.</div></div></body></html>`);
}

app.use(async (req, res, next) => {
    logSecurityEvent(req, detectSecurityEvent(req));
    next();
});

app.use(async (req, res, next) => {
    if (req.session?.isAdmin) return next();
    if (req.path === '/login' || req.path === '/admin' || req.path === '/admin.html' || req.path === '/admin-login' || req.path.startsWith('/api/admin')) return next();
    try {
        const settingsMap = await getSettingsMapAsync();
        if (Number(settingsMap.maintenance_mode || 0) === 1) {
            return sendMaintenanceResponse(req, res, settingsMap);
        }
        next();
    } catch (e) {
        next();
    }
});

app.use((req, res, next) => {
    if (req.session?.isAdmin) return next();
    if (req.path === '/login' || req.path === '/admin.html' || req.path.startsWith('/api/admin')) return next();

    const isPublicHtmlRequest = req.method === 'GET' && (
        req.path === '/' ||
        req.path === '/analizler' ||
        req.path === '/forum' ||
        req.path === '/index.html' ||
        req.path === '/analizler.html' ||
        req.path === '/forum.html' ||
        req.path === '/page.html' ||
        req.path.startsWith('/p/')
    );
    const isPublicApiRequest = req.path.startsWith('/api/') && !req.path.startsWith('/api/admin');
    if (!isPublicHtmlRequest && !isPublicApiRequest) return next();

    const context = getClientContext(req);
    findBanByContext(context, (err, banRow) => {
        if (err) return res.status(500).json({ status: 'error' });
        if (banRow) return sendBanResponse(req, res, banRow);
        next();
    });
});

// Admin Yetki Kontrolü
function hasPerm(req, perm) { if(req.session.adminRole === 'superadmin') return true; return (req.session.adminPerms || []).includes(perm); }

app.use('/api/admin', (req, res, next) => {
    if(req.path === '/login' || req.path === '/logout') return next();
    if(!req.session.isAdmin) return res.status(401).json({status: 'error', msg: 'unauthorized'});
    
    db.get(`SELECT role, perms, display_name, session_version, force_logout_message FROM admins WHERE username = ?`, [req.session.adminUser], (err, row) => {
        if(!row) {
            return req.session.destroy(() => res.status(401).json({status: 'forced_logout', msg: 'Yönetim tarafından hesabınız silindi.'}));
        }
        if ((req.session.adminSessionVersion ?? 0) !== (row.session_version ?? 0)) {
            const forcedMessage = row.force_logout_message || 'Yönetim tarafından sistemden çıkarıldınız.';
            return req.session.destroy(() => res.status(401).json({status: 'forced_logout', msg: forcedMessage}));
        }
        req.session.adminRole = row.role;
        req.session.adminPerms = JSON.parse(row.perms || '[]');
        req.session.adminDisplayName = row.display_name || req.session.adminUser;
        db.run(`UPDATE admins SET last_seen = CURRENT_TIMESTAMP WHERE username = ?`, [req.session.adminUser]);
        next();
    });
});

function addLog(req, islem) {
    const context = getClientContext(req);
    const ip = context.ip;
    const dev = `${context.device} / ${context.browser}`;
    db.run(`INSERT INTO logs (islem, admin_user, ip_adresi, cihaz_bilgisi) VALUES (?,?,?,?)`, [islem, req.session.adminUser || 'Sistem', ip, dev]);
}

function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}

function parseSqliteUtcDate(value) {
    if (!value) return null;
    const normalized = String(value).trim().replace(' ', 'T');
    const isoValue = /z$/i.test(normalized) ? normalized : `${normalized}Z`;
    const parsed = new Date(isoValue);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getArchiveTypeLabel(type) {
    if (type === 'forum') return 'VIP FORUM';
    if (type === 'visitor') return 'Ziyaretci';
    return 'Form Kaydi';
}

async function getArchivedRecords() {
    return dbAllAsync(
        `SELECT 'user' as type, id, 'user:' || id as record_key, ad as ad_ip, telefon as bilgi, tarih FROM users WHERE is_archived = 1
         UNION ALL
         SELECT 'forum' as type, id, 'forum:' || id as record_key, ad as ad_ip, telefon || ' • ' || ulasim_tercihi as bilgi, tarih FROM forum_requests WHERE is_archived = 1
         UNION ALL
         SELECT 'visitor' as type, id, 'visitor:' || id as record_key, ip as ad_ip, konum as bilgi, tarih FROM visitors WHERE is_archived = 1
         ORDER BY tarih DESC`
    );
}

function filterArchivedRecords(rows, rawItems) {
    const items = Array.isArray(rawItems) ? rawItems : [];
    if (items.length === 0) return rows;
    const keys = new Set(
        items
            .map(item => {
                const type = String(item?.type || '').trim();
                const id = Number(item?.id);
                if (!['user', 'forum', 'visitor'].includes(type) || !Number.isInteger(id)) return '';
                return `${type}:${id}`;
            })
            .filter(Boolean)
    );
    return rows.filter(row => keys.has(`${row.type}:${row.id}`));
}

function escapeCsvValue(value) {
    const text = String(value ?? '');
    if (/[",\n;]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function buildArchiveCsv(rows) {
    const header = ['Tarih', 'Tur', 'Kayit', 'Bilgi'];
    const lines = rows.map(row => [
        row.tarih ? new Date(row.tarih).toLocaleString('tr-TR') : '-',
        getArchiveTypeLabel(row.type),
        row.ad_ip || '-',
        row.bilgi || '-'
    ].map(escapeCsvValue).join(';'));
    return [header.join(';'), ...lines].join('\n');
}

function sanitizeEmailAddress(value) {
    const email = String(value || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function createMailerTransport() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
    if (!host || !port || !user || !pass) return null;
    return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

function dbGetAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
    });
}

async function getSettingsMapAsync() {
    const rows = await dbAllAsync(`SELECT anahtar, deger FROM settings`);
    return Object.fromEntries(rows.map(row => [row.anahtar, row.deger]));
}

async function getSecureSettingsMapAsync() {
    const rows = await dbAllAsync(`SELECT anahtar, deger FROM secure_settings`);
    return Object.fromEntries(rows.map(row => [row.anahtar, row.deger]));
}

async function getAiConfigAsync() {
    const secure = await getSecureSettingsMapAsync();
    return {
        ai_provider: String(secure.ai_provider || 'openai').trim() || 'openai',
        ai_base_url: String(secure.ai_base_url || 'https://api.openai.com/v1/chat/completions').trim() || 'https://api.openai.com/v1/chat/completions',
        ai_api_key: String(secure.ai_api_key || '').trim(),
        ai_model: String(secure.ai_model || 'gpt-5.4').trim() || 'gpt-5.4',
        ai_system_prompt: String(secure.ai_system_prompt || 'Sen yönetim paneli içinde çalışan, net ve görev odaklı bir yardımcı yapay zekasın.').trim(),
        ai_temperature: String(secure.ai_temperature || '0.7').trim() || '0.7'
    };
}

function getAiProviderPreset(provider) {
    const key = String(provider || 'openai').trim().toLowerCase();
    const presets = {
        openai: {
            endpoint: 'https://api.openai.com/v1/chat/completions',
            defaultModel: 'gpt-5.4'
        },
        openai_compatible: {
            endpoint: 'https://api.openai.com/v1/chat/completions',
            defaultModel: 'gpt-5.4'
        },
        openrouter: {
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            defaultModel: 'openai/gpt-4.1'
        },
        groq: {
            endpoint: 'https://api.groq.com/openai/v1/chat/completions',
            defaultModel: 'llama-3.3-70b-versatile'
        },
        together: {
            endpoint: 'https://api.together.xyz/v1/chat/completions',
            defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
        },
        mistral: {
            endpoint: 'https://api.mistral.ai/v1/chat/completions',
            defaultModel: 'mistral-large-latest'
        },
        fireworks: {
            endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
            defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct'
        },
        perplexity: {
            endpoint: 'https://api.perplexity.ai/chat/completions',
            defaultModel: 'sonar-pro'
        },
        anthropic: {
            endpoint: 'https://api.anthropic.com/v1/messages',
            defaultModel: 'claude-3-7-sonnet-latest'
        },
        gemini: {
            endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
            defaultModel: 'gemini-2.5-pro'
        }
    };
    return presets[key] || presets.openai;
}

function sanitizeAiMessages(rawMessages) {
    const allowedRoles = new Set(['user', 'assistant', 'system']);
    const list = Array.isArray(rawMessages) ? rawMessages : [];
    return list
        .map(item => ({
            role: allowedRoles.has(String(item?.role || '').trim()) ? String(item.role).trim() : 'user',
            content: String(item?.content || '').trim()
        }))
        .filter(item => item.content)
        .slice(-20);
}

function extractAiResponseText(data) {
    const direct = data?.choices?.[0]?.message?.content;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    if (Array.isArray(direct)) {
        const joined = direct
            .map(part => typeof part?.text === 'string' ? part.text : '')
            .filter(Boolean)
            .join('\n')
            .trim();
        if (joined) return joined;
    }
    if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
    if (Array.isArray(data?.content)) {
        const joined = data.content
            .map(part => typeof part?.text === 'string' ? part.text : '')
            .filter(Boolean)
            .join('\n')
            .trim();
        if (joined) return joined;
    }
    return '';
}

function toGeminiContents(messages) {
    return messages.map(item => ({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: item.content }]
    }));
}

function extractGeminiResponseText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n').trim();
}

function extractAnthropicResponseText(data) {
    const content = Array.isArray(data?.content) ? data.content : [];
    return content.map(item => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('\n').trim();
}

async function requestAiChatCompletion(config, messages, modelOverride = '') {
    const apiKey = String(config.ai_api_key || '').trim();
    const provider = String(config.ai_provider || 'openai').trim().toLowerCase();
    const preset = getAiProviderPreset(provider);
    const baseUrl = String(config.ai_base_url || preset.endpoint || '').trim();
    const model = String(modelOverride || config.ai_model || preset.defaultModel || 'gpt-5.4').trim() || preset.defaultModel || 'gpt-5.4';
    const temperature = Number(config.ai_temperature || 0.7);
    if (!apiKey || !baseUrl) throw new Error('AI yapılandırması eksik. Önce API anahtarı ve endpoint tanımlayın.');

    const normalizedTemperature = Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : 0.7;

    if (provider === 'gemini') {
        const endpointBase = baseUrl.replace(/\/+$/, '');
        const response = await axios.post(`${endpointBase}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
            systemInstruction: config.ai_system_prompt ? {
                parts: [{ text: String(config.ai_system_prompt).trim() }]
            } : undefined,
            contents: toGeminiContents(messages.filter(item => item.role !== 'system')),
            generationConfig: {
                temperature: normalizedTemperature
            }
        }, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 120000,
            maxBodyLength: Infinity
        });
        const text = extractGeminiResponseText(response.data);
        if (!text) throw new Error('Gemini yanıtı boş döndü.');
        return text;
    }

    if (provider === 'anthropic') {
        const response = await axios.post(baseUrl, {
            model,
            system: String(config.ai_system_prompt || '').trim() || undefined,
            max_tokens: 4096,
            temperature: normalizedTemperature,
            messages: messages.filter(item => item.role !== 'system').map(item => ({
                role: item.role === 'assistant' ? 'assistant' : 'user',
                content: item.content
            }))
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            timeout: 120000,
            maxBodyLength: Infinity
        });
        const text = extractAnthropicResponseText(response.data);
        if (!text) throw new Error('Anthropic yanıtı boş döndü.');
        return text;
    }

    const payload = {
        model,
        messages,
        temperature: normalizedTemperature
    };

    const response = await axios.post(baseUrl, payload, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        timeout: 120000,
        maxBodyLength: Infinity
    });
    const text = extractAiResponseText(response.data);
    if (!text) throw new Error('AI yanıtı boş döndü. Endpoint modelle uyumlu olmayabilir.');
    return text;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function dbGetAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}

function dbRunAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function isGitHubOAuthConfigured() {
    return !!(GITHUB_OAUTH_CONFIG.clientId && GITHUB_OAUTH_CONFIG.clientSecret && GITHUB_OAUTH_CONFIG.repo && GITHUB_OAUTH_CONFIG.baseUrl);
}

function getGitHubRedirectUri() {
    return `${GITHUB_OAUTH_CONFIG.baseUrl}/api/admin/github/callback`;
}

function getGitHubRepoParts() {
    const [owner, repo] = String(GITHUB_OAUTH_CONFIG.repo || '').split('/');
    return { owner: String(owner || '').trim(), repo: String(repo || '').trim() };
}

function encodeRepoPath(repoPath = '') {
    return String(repoPath || '').split('/').filter(Boolean).map(part => encodeURIComponent(part)).join('/');
}

async function githubApiRequest({ method = 'get', url, token, data, params }) {
    const response = await axios({
        method,
        url,
        data,
        params,
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'VIP-CRM-GitHub-Editor',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
    });
    return response.data;
}

async function getGitHubRepoContext(token) {
    const { owner, repo } = getGitHubRepoParts();
    if (!owner || !repo) throw new Error('github-repo-config');
    const repoInfo = await githubApiRequest({ method: 'get', url: `https://api.github.com/repos/${owner}/${repo}`, token });
    return {
        owner,
        repo,
        defaultBranch: repoInfo.default_branch,
        private: !!repoInfo.private,
        htmlUrl: repoInfo.html_url,
        fullName: repoInfo.full_name
    };
}

async function getGitHubRepoTree(token) {
    const context = await getGitHubRepoContext(token);
    const branchInfo = await githubApiRequest({ method: 'get', url: `https://api.github.com/repos/${context.owner}/${context.repo}/branches/${encodeURIComponent(context.defaultBranch)}`, token });
    const commitInfo = await githubApiRequest({ method: 'get', url: branchInfo.commit.url, token });
    const treeInfo = await githubApiRequest({ method: 'get', url: `${commitInfo.tree.url}?recursive=1`, token });
    return {
        ...context,
        files: Array.isArray(treeInfo.tree)
            ? treeInfo.tree
                .filter(item => item.type === 'blob')
                .map(item => ({ path: item.path, sha: item.sha, size: item.size || 0 }))
            : []
    };
}

async function getGitHubFile(token, repoPath) {
    const context = await getGitHubRepoContext(token);
    const fileInfo = await githubApiRequest({
        method: 'get',
        url: `https://api.github.com/repos/${context.owner}/${context.repo}/contents/${encodeRepoPath(repoPath)}`,
        token,
        params: { ref: context.defaultBranch }
    });
    if (Array.isArray(fileInfo)) throw new Error('github-directory-path');
    const content = fileInfo.encoding === 'base64' ? Buffer.from(String(fileInfo.content || '').replace(/\n/g, ''), 'base64').toString('utf8') : '';
    return {
        ...context,
        path: fileInfo.path,
        sha: fileInfo.sha,
        content
    };
}

async function saveGitHubFile(token, repoPath, content, sha, message, actor) {
    const context = await getGitHubRepoContext(token);
    let currentSha = sha;
    if (!currentSha) {
        const current = await getGitHubFile(token, repoPath);
        currentSha = current.sha;
    }
    return githubApiRequest({
        method: 'put',
        url: `https://api.github.com/repos/${context.owner}/${context.repo}/contents/${encodeRepoPath(repoPath)}`,
        token,
        data: {
            message: message || `Panel üzerinden ${repoPath} güncellendi`,
            content: Buffer.from(String(content || ''), 'utf8').toString('base64'),
            sha: currentSha,
            branch: context.defaultBranch,
            committer: actor?.login ? {
                name: actor.name || actor.login,
                email: actor.email || `${actor.login}@users.noreply.github.com`
            } : undefined
        }
    });
}

function normalizeChatMessage(value, maxLength = 1800) {
    return String(value || '').replace(/\r/g, '').trim().slice(0, maxLength);
}

function sanitizeAttachmentName(value) {
    const baseName = String(value || 'dosya')
        .replace(/[\\/]+/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, '')
        .replace(/[^A-Za-z0-9._()\-\sğüşöçıİĞÜŞÖÇ]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return baseName || 'dosya';
}

function getAttachmentSignatureStatus(mimeType, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
    if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (mimeType === 'image/webp') return buffer.subarray(0, 4).equals(Buffer.from('RIFF')) && buffer.subarray(8, 12).equals(Buffer.from('WEBP'));
    if (mimeType === 'application/pdf') return buffer.subarray(0, 5).equals(Buffer.from('%PDF-'));
    return false;
}

function parseChatAttachmentInput(rawAttachment) {
    if (!rawAttachment || typeof rawAttachment !== 'object') return null;
    const originalName = sanitizeAttachmentName(rawAttachment.name);
    const mimeType = String(rawAttachment.type || '').trim().toLowerCase();
    const config = CHAT_ATTACHMENT_ALLOWED_TYPES[mimeType];
    if (!config) return { error: 'Sadece JPG, PNG, WEBP veya PDF dosyasi gonderebilirsiniz.' };
    const dataMatch = String(rawAttachment.data || '').match(/^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i);
    if (!dataMatch || String(dataMatch[1] || '').trim().toLowerCase() !== mimeType) {
        return { error: 'Dosya verisi gecersiz veya bozulmus.' };
    }
    const buffer = Buffer.from(String(dataMatch[2] || '').replace(/\s+/g, ''), 'base64');
    if (!buffer.length || buffer.length > CHAT_ATTACHMENT_MAX_BYTES) {
        return { error: 'Dosya boyutu en fazla 4 MB olabilir.' };
    }
    if (!getAttachmentSignatureStatus(mimeType, buffer)) {
        return { error: 'Dosya icerigi izin verilen format ile eslesmiyor.' };
    }
    return {
        originalName,
        mimeType,
        buffer,
        fileSize: buffer.length,
        fileKind: config.kind,
        ext: config.ext,
        allowInline: config.allowInline
    };
}

function buildChatAttachmentPublicMeta(row) {
    if (!row) return null;
    return {
        token: row.token,
        name: row.original_name,
        size: Number(row.file_size || 0),
        mimeType: row.mime_type,
        kind: row.file_kind,
        url: `/api/chat/file/${row.token}`
    };
}

async function storeChatAttachment(req, chatId, rawAttachment, uploadedBy = 'visitor') {
    const parsed = parseChatAttachmentInput(rawAttachment);
    if (!parsed || parsed.error) {
        if (parsed?.error) {
            logSecurityEvent(req, {
                eventType: 'chat-upload-rejected',
                riskLevel: 'medium',
                requestPath: req.path || '/api/chat/send',
                queryText: '',
                payloadExcerpt: truncateText(JSON.stringify({ name: rawAttachment?.name || '', type: rawAttachment?.type || '' }), 220),
                userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
                detectionReason: parsed.error
            });
        }
        return { error: parsed?.error || 'Dosya okunamadi.' };
    }
    const token = crypto.randomBytes(24).toString('hex');
    const storedName = `${token}${parsed.ext}`;
    const filePath = path.join(CHAT_ATTACHMENT_DIR, storedName);
    fs.writeFileSync(filePath, parsed.buffer, { flag: 'wx' });
    try {
        await dbRunAsync(
            `INSERT INTO chat_attachments (chat_id, token, stored_name, original_name, mime_type, file_size, file_kind, uploaded_by) VALUES (?,?,?,?,?,?,?,?)`,
            [chatId, token, storedName, parsed.originalName, parsed.mimeType, parsed.fileSize, parsed.fileKind, uploadedBy]
        );
        return buildChatAttachmentPublicMeta({
            token,
            original_name: parsed.originalName,
            file_size: parsed.fileSize,
            mime_type: parsed.mimeType,
            file_kind: parsed.fileKind
        });
    } catch (error) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        throw error;
    }
}

function buildSupportTeamAttachmentPublicMeta(row) {
    if (!row) return null;
    return {
        token: row.token,
        name: row.original_name,
        size: Number(row.file_size || 0),
        mimeType: row.mime_type,
        kind: row.file_kind,
        url: `/api/admin/support-team-chat/file/${row.token}`
    };
}

async function storeSupportTeamAttachment(req, messageId, rawAttachment, uploadedBy = 'admin') {
    const parsed = parseChatAttachmentInput(rawAttachment);
    if (!parsed || parsed.error) {
        if (parsed?.error) {
            logSecurityEvent(req, {
                eventType: 'support-team-upload-rejected',
                riskLevel: 'medium',
                requestPath: req.path || '/api/admin/support-team-chat',
                queryText: '',
                payloadExcerpt: truncateText(JSON.stringify({ name: rawAttachment?.name || '', type: rawAttachment?.type || '' }), 220),
                userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
                detectionReason: parsed.error
            });
        }
        return { error: parsed?.error || 'Dosya okunamadi.' };
    }
    const token = crypto.randomBytes(24).toString('hex');
    const storedName = `${token}${parsed.ext}`;
    const filePath = path.join(CHAT_ATTACHMENT_DIR, storedName);
    fs.writeFileSync(filePath, parsed.buffer, { flag: 'wx' });
    try {
        await dbRunAsync(
            `INSERT INTO support_team_attachments (message_id, token, stored_name, original_name, mime_type, file_size, file_kind, uploaded_by) VALUES (?,?,?,?,?,?,?,?)`,
            [messageId, token, storedName, parsed.originalName, parsed.mimeType, parsed.fileSize, parsed.fileKind, uploadedBy]
        );
        return buildSupportTeamAttachmentPublicMeta({
            token,
            original_name: parsed.originalName,
            file_size: parsed.fileSize,
            mime_type: parsed.mimeType,
            file_kind: parsed.fileKind
        });
    } catch (error) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        throw error;
    }
}

async function deleteChatAttachments(chatIds) {
    const ids = Array.isArray(chatIds) ? chatIds.map(id => Number(id)).filter(Number.isInteger) : [];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const rows = await dbAllAsync(`SELECT id, stored_name FROM chat_attachments WHERE chat_id IN (${placeholders})`, ids);
    for (const row of rows) {
        const filePath = path.join(CHAT_ATTACHMENT_DIR, row.stored_name || '');
        try {
            if (filePath.startsWith(CHAT_ATTACHMENT_DIR) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {}
    }
    await dbRunAsync(`DELETE FROM chat_attachments WHERE chat_id IN (${placeholders})`, ids);
}

function stripHtml(value) {
    return String(value || '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncateText(value, maxLength = 160) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function getBaseUrl(req, settingsMap) {
    const configured = String(settingsMap.seo_base_url || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    return `${protocol}://${req.get('host')}`;
}

function toAbsoluteUrl(req, settingsMap, value, fallbackPath = '/') {
    const raw = String(value || '').trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    const baseUrl = getBaseUrl(req, settingsMap);
    const pathValue = raw || fallbackPath || '/';
    return `${baseUrl}${pathValue.startsWith('/') ? pathValue : `/${pathValue}`}`;
}

function buildSeoModel(req, settingsMap, overrides = {}) {
    const baseTitle = String(settingsMap.seo_default_title || settingsMap.logo_text || settingsMap.seo_site_name || 'VIP').trim();
    const baseDescription = String(settingsMap.seo_default_description || '').trim();
    const baseKeywords = String(settingsMap.seo_default_keywords || '').trim();
    const routePath = overrides.routePath || '/';
    const title = String(overrides.title || baseTitle).trim() || baseTitle;
    const description = truncateText(overrides.description || baseDescription || title, 180);
    const keywords = String(overrides.keywords || baseKeywords || '').trim();
    const image = toAbsoluteUrl(req, settingsMap, overrides.image || settingsMap.seo_default_image || '', routePath);
    const canonical = toAbsoluteUrl(req, settingsMap, overrides.canonical || '', routePath);
    const robots = Number(overrides.noindex) === 1 ? 'noindex, nofollow' : 'index, follow';
    return {
        title,
        description,
        keywords,
        image,
        canonical,
        robots,
        siteName: String(settingsMap.seo_site_name || settingsMap.logo_text || 'VIP').trim() || 'VIP',
        routePath,
        noindex: Number(overrides.noindex) === 1
    };
}

function buildSeoMetaTags(seo) {
    const tags = [
        `<meta name="description" content="${escapeHtml(seo.description)}">`,
        `<meta name="robots" content="${escapeHtml(seo.robots)}">`,
        `<link rel="canonical" href="${escapeHtml(seo.canonical)}">`,
        `<meta property="og:locale" content="tr_TR">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:title" content="${escapeHtml(seo.title)}">`,
        `<meta property="og:description" content="${escapeHtml(seo.description)}">`,
        `<meta property="og:url" content="${escapeHtml(seo.canonical)}">`,
        `<meta property="og:site_name" content="${escapeHtml(seo.siteName)}">`,
        `<meta property="og:image" content="${escapeHtml(seo.image)}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:title" content="${escapeHtml(seo.title)}">`,
        `<meta name="twitter:description" content="${escapeHtml(seo.description)}">`,
        `<meta name="twitter:image" content="${escapeHtml(seo.image)}">`
    ];
    if (seo.keywords) tags.splice(1, 0, `<meta name="keywords" content="${escapeHtml(seo.keywords)}">`);
    const schema = {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: seo.title,
        description: seo.description,
        url: seo.canonical
    };
    tags.push(`<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`);
    return tags.join('\n    ');
}

function renderHtmlWithSeo(fileName, settingsMap, seo) {
    const filePath = path.join(__dirname, fileName);
    let html = fs.readFileSync(filePath, 'utf8');
    html = html.replace(/<title id="mainTitle">[\s\S]*?<\/title>/i, `<title id="mainTitle">${escapeHtml(seo.title)}</title>`);
    html = html.replace(/<link id="siteFavicon" rel="shortcut icon" href="[^"]*">/i, `<link id="siteFavicon" rel="shortcut icon" href="${escapeHtml(settingsMap.site_favicon || '')}">`);
    html = html.replace(/<\/head>/i, `    ${buildSeoMetaTags(seo)}\n</head>`);
    return html;
}

function getSystemSeoConfig(req, settingsMap, pageKey) {
    const routeMap = { index: '/', analizler: '/analizler', forum: '/forum' };
    const titleMap = { index: settingsMap.hero_title, analizler: settingsMap.analiz_title, forum: settingsMap.forum_title };
    const descriptionMap = { index: settingsMap.hero_subtitle, analizler: settingsMap.analiz_subtitle, forum: settingsMap.forum_intro };
    const imageMap = { index: settingsMap.hero_image, analizler: settingsMap.analiz_image, forum: settingsMap.forum_image };
    const prefix = pageKey;
    return buildSeoModel(req, settingsMap, {
        routePath: routeMap[pageKey] || '/',
        title: settingsMap[`${prefix}_seo_title`] || titleMap[pageKey] || settingsMap.seo_default_title,
        description: settingsMap[`${prefix}_seo_description`] || stripHtml(descriptionMap[pageKey] || ''),
        keywords: settingsMap[`${prefix}_seo_keywords`] || settingsMap.seo_default_keywords,
        image: settingsMap[`${prefix}_seo_image`] || imageMap[pageKey] || settingsMap.seo_default_image,
        canonical: settingsMap[`${prefix}_seo_canonical`] || routeMap[pageKey] || '/',
        noindex: Number(settingsMap[`${prefix}_seo_noindex`] || 0)
    });
}

function getDynamicSeoConfig(req, settingsMap, page) {
    const routePath = `/p/${page?.slug || ''}`;
    return buildSeoModel(req, settingsMap, {
        routePath,
        title: page?.seo_title || page?.baslik || settingsMap.seo_default_title,
        description: page?.seo_description || stripHtml(page?.icerik || ''),
        keywords: page?.seo_keywords || settingsMap.seo_default_keywords,
        image: page?.seo_image || page?.resim_url || settingsMap.seo_default_image,
        canonical: page?.seo_canonical || routePath,
        noindex: Number(page?.seo_noindex || 0)
    });
}

function looksLikeImageUrl(value) {
    return /\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i.test(String(value || '').trim());
}

function extractHtmlTitle(html) {
    const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return stripHtml(match ? match[1] : '');
}

function findMetaContent(html, attrName, attrValue) {
    const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
    const target = String(attrValue || '').toLowerCase();
    for (const tag of tags) {
        const attrMatch = tag.match(new RegExp(`${attrName}=["']([^"']+)["']`, 'i'));
        if (!attrMatch || String(attrMatch[1]).toLowerCase() !== target) continue;
        const contentMatch = tag.match(/content=["']([^"']*)["']/i);
        return contentMatch ? String(contentMatch[1]).trim() : '';
    }
    return '';
}

function findLinkHref(html, relValue) {
    const tags = String(html || '').match(/<link\b[^>]*>/gi) || [];
    const target = String(relValue || '').toLowerCase();
    for (const tag of tags) {
        const relMatch = tag.match(/rel=["']([^"']+)["']/i);
        if (!relMatch || String(relMatch[1]).toLowerCase() !== target) continue;
        const hrefMatch = tag.match(/href=["']([^"']*)["']/i);
        return hrefMatch ? String(hrefMatch[1]).trim() : '';
    }
    return '';
}

function extractSeoAuditSnapshot(html) {
    return {
        title: extractHtmlTitle(html),
        description: findMetaContent(html, 'name', 'description'),
        keywords: findMetaContent(html, 'name', 'keywords'),
        robots: findMetaContent(html, 'name', 'robots'),
        canonical: findLinkHref(html, 'canonical'),
        ogTitle: findMetaContent(html, 'property', 'og:title'),
        ogDescription: findMetaContent(html, 'property', 'og:description'),
        ogImage: findMetaContent(html, 'property', 'og:image'),
        twitterImage: findMetaContent(html, 'name', 'twitter:image'),
        hasSchema: /<script type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/i.test(String(html || ''))
    };
}

function summarizeAuditStatus(checks) {
    const failCount = checks.filter(check => check.status === 'fail').length;
    const warnCount = checks.filter(check => check.status === 'warn').length;
    if (failCount > 0) return 'problem';
    if (warnCount > 0) return 'warning';
    return 'good';
}

function scoreAuditChecks(checks) {
    return Math.max(0, checks.reduce((score, check) => {
        if (check.status === 'pass') return score + 16;
        if (check.status === 'warn') return score + 8;
        return score;
    }, 0));
}

function buildSeoAuditReport(pageInfo) {
    const { label, routePath, seo, html, listedInSitemap, explicitImage } = pageInfo;
    const snapshot = extractSeoAuditSnapshot(html);
    const checks = [];
    const pushCheck = (status, labelText, detail) => checks.push({ status, label: labelText, detail });

    const titleLength = snapshot.title.length;
    if (!snapshot.title) pushCheck('fail', 'SEO baslik eksik', 'Sayfa title etiketi uretmiyor.');
    else if (titleLength < 20 || titleLength > 65) pushCheck('warn', 'SEO baslik uzunlugu sinirda', `${titleLength} karakter. 20-65 araligi daha guvenlidir.`);
    else pushCheck('pass', 'SEO baslik uygun', `${titleLength} karakter.`);

    const descriptionLength = snapshot.description.length;
    if (!snapshot.description) pushCheck('fail', 'Meta aciklama eksik', 'Description etiketi bulunamadi.');
    else if (descriptionLength < 70 || descriptionLength > 180) pushCheck('warn', 'Meta aciklama sinirda', `${descriptionLength} karakter. 70-180 araligi daha sagliklidir.`);
    else pushCheck('pass', 'Meta aciklama uygun', `${descriptionLength} karakter.`);

    if (!snapshot.canonical) pushCheck('fail', 'Canonical eksik', 'Canonical link etiketi yok.');
    else if (snapshot.canonical !== seo.canonical) pushCheck('warn', 'Canonical beklenenden farkli', `Beklenen ${seo.canonical}, bulunan ${snapshot.canonical}`);
    else pushCheck('pass', 'Canonical dogru', snapshot.canonical);

    const expectedRobots = seo.noindex ? 'noindex, nofollow' : 'index, follow';
    if (!snapshot.robots) pushCheck('fail', 'Robots etiketi eksik', 'Robots meta etiketi bulunamadi.');
    else if (snapshot.robots.toLowerCase() !== expectedRobots) pushCheck('warn', 'Robots etiketi farkli', `Beklenen ${expectedRobots}, bulunan ${snapshot.robots}`);
    else pushCheck('pass', 'Robots etiketi dogru', snapshot.robots);

    if (!snapshot.ogTitle || !snapshot.ogDescription) pushCheck('warn', 'Open Graph eksik', 'og:title veya og:description alani tam degil.');
    else pushCheck('pass', 'Open Graph tamam', 'Baslik ve aciklama sosyal paylasim icin hazir.');

    if (!explicitImage) pushCheck('warn', 'Paylasim gorseli zayif', 'Bu sayfa icin ozel bir SEO gorseli tanimli degil.');
    else if (!looksLikeImageUrl(explicitImage)) pushCheck('warn', 'Paylasim gorseli supheli', 'SEO gorseli bir resim dosyasi gibi gorunmuyor.');
    else if (!snapshot.ogImage || !snapshot.twitterImage) pushCheck('warn', 'Sosyal gorsel etiketi eksik', 'og:image veya twitter:image alani eksik.');
    else pushCheck('pass', 'Paylasim gorseli hazir', snapshot.ogImage);

    if (snapshot.hasSchema) pushCheck('pass', 'Schema mevcut', 'JSON-LD WebPage semasi eklendi.');
    else pushCheck('warn', 'Schema eksik', 'JSON-LD semasi bulunamadi.');

    if (seo.noindex && listedInSitemap) pushCheck('fail', 'Sitemap celiskisi', 'Noindex sayfa sitemap icinde kalmis.');
    else if (!seo.noindex && !listedInSitemap) pushCheck('fail', 'Sitemap disi sayfa', 'Index sayfasi sitemap icinde gorunmuyor.');
    else if (seo.noindex) pushCheck('pass', 'Noindex kurali dogru', 'Bu sayfa bilerek sitemap disinda tutuluyor.');
    else pushCheck('pass', 'Sitemap kaydi dogru', 'Sayfa sitemap icinde yer aliyor.');

    return {
        label,
        routePath,
        canonical: snapshot.canonical || seo.canonical,
        title: snapshot.title,
        description: snapshot.description,
        noindex: seo.noindex,
        listedInSitemap,
        score: Math.min(100, scoreAuditChecks(checks)),
        status: summarizeAuditStatus(checks),
        checks
    };
}

function parsePermList(permsText) {
    try {
        const parsed = JSON.parse(permsText || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function canAccessChatRow(req, chatRow) {
    if (!chatRow) return false;
    if (req.session.adminRole === 'superadmin') return true;
    return chatRow.assigned_admin === req.session.adminUser;
}

function isSupportVisibleAdmin(row) {
    if (!row) return false;
    if (row.role === 'superadmin') return true;
    return row.role === 'moderator' && parsePermList(row.perms).includes('support');
}

function getSupportRoster(callback) {
    db.all(`SELECT id, username, role, perms, display_name, last_seen, support_active FROM admins ORDER BY id ASC`, [], (err, rows) => {
        if (err || !rows) return callback([]);

        const activeThreshold = Date.now() - (SUPPORT_AGENT_ACTIVE_WINDOW_SECONDS * 1000);
        const supportRows = rows.filter(isSupportVisibleAdmin);
        if (supportRows.length === 0) return callback([]);

        db.all(`SELECT assigned_admin, COUNT(*) as active_count FROM chats WHERE is_active = 1 AND assigned_admin IS NOT NULL AND TRIM(assigned_admin) != '' GROUP BY assigned_admin`, [], (countErr, countRows) => {
            if (countErr) return callback([]);
            const counts = Object.fromEntries((countRows || []).map(row => [row.assigned_admin, Number(row.active_count) || 0]));
            db.all(`SELECT assigned_admin,
                               SUM(CASE WHEN date(tarih) = date('now') THEN 1 ELSE 0 END) AS daily_count,
                               SUM(CASE WHEN strftime('%Y-%m', tarih) = strftime('%Y-%m', 'now') THEN 1 ELSE 0 END) AS monthly_count
                        FROM chats
                        WHERE assigned_admin IS NOT NULL AND TRIM(assigned_admin) != ''
                        GROUP BY assigned_admin`, [], (statsErr, statRows) => {
                if (statsErr) return callback([]);
                const stats = Object.fromEntries((statRows || []).map(row => [row.assigned_admin, {
                    daily_count: Number(row.daily_count) || 0,
                    monthly_count: Number(row.monthly_count) || 0
                }]));
                const roster = supportRows.map(row => {
                    const seenAt = parseSqliteUtcDate(row?.last_seen);
                    const activeNow = !!(seenAt && !Number.isNaN(seenAt.getTime()) && seenAt.getTime() >= activeThreshold);
                    const supportEnabled = Number(row.support_active ?? 1) !== 0;
                    const activeCount = counts[row.username] || 0;
                    const activityStats = stats[row.username] || { daily_count: 0, monthly_count: 0 };
                    return {
                        id: row.id,
                        username: row.username,
                        role: row.role,
                        display_name: (row.display_name || '').trim() || row.username,
                        support_enabled: supportEnabled,
                        active_now: activeNow,
                        active_count: activeCount,
                        daily_visitor_count: activityStats.daily_count,
                        monthly_visitor_count: activityStats.monthly_count,
                        available_for_new_chats: supportEnabled && activeNow && activeCount < SUPPORT_CHAT_LIMIT,
                        last_seen: row.last_seen || ''
                    };
                }).sort((left, right) => {
                    if (left.available_for_new_chats !== right.available_for_new_chats) return left.available_for_new_chats ? -1 : 1;
                    if (left.active_now !== right.active_now) return left.active_now ? -1 : 1;
                    if (left.support_enabled !== right.support_enabled) return left.support_enabled ? -1 : 1;
                    if (left.role !== right.role) return left.role === 'moderator' ? -1 : 1;
                    return left.display_name.localeCompare(right.display_name, 'tr');
                });
                callback(roster);
            });
        });
    });
}

function getSupportAgentByUsername(username, callback) {
    getSupportRoster((roster) => {
        callback((roster || []).find(agent => agent.username === username) || null);
    });
}

async function findLatestChatForClient(context, options = {}) {
    const onlyActive = options.onlyActive === true;
    const fingerprint = normalizeDeviceFingerprint(context?.deviceFingerprint);
    const ip = String(context?.ip || '').trim();
    const activeSql = onlyActive ? 'AND is_active = 1' : '';

    if (fingerprint) {
        const fingerprintRow = await dbGetAsync(
            `SELECT * FROM chats WHERE device_fingerprint = ? ${activeSql} ORDER BY id DESC LIMIT 1`,
            [fingerprint]
        );
        if (fingerprintRow) return fingerprintRow;
    }

    if (!ip) return null;

    const ipRow = await dbGetAsync(
        `SELECT * FROM chats WHERE ip = ? ${activeSql} ORDER BY id DESC LIMIT 1`,
        [ip]
    );

    if (ipRow && fingerprint && !normalizeDeviceFingerprint(ipRow.device_fingerprint)) {
        await dbRunAsync(`UPDATE chats SET device_fingerprint = ? WHERE id = ?`, [fingerprint, ipRow.id]);
        return { ...ipRow, device_fingerprint: fingerprint };
    }

    return ipRow || null;
}

function getAvailableSupportAgents(callback) {
    getSupportRoster((roster) => {
        const supportModerators = (roster || []).filter(agent => agent.role === 'moderator' && agent.support_enabled && agent.active_now);
        const fallbackSuperadmins = (roster || []).filter(agent => agent.role === 'superadmin' && agent.support_enabled && agent.active_now);
        const team = supportModerators.length > 0 ? supportModerators : fallbackSuperadmins;
        callback(team);
    });
}

function parseRejectedAdmins(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : [];
    } catch (e) {
        return [];
    }
}

function chooseSupportAgentForChat(chatRow, availableAgents) {
    const agents = Array.isArray(availableAgents) ? availableAgents.slice() : [];
    if (agents.length === 0) return null;

    const rejectedAdmins = new Set(parseRejectedAdmins(chatRow?.rejected_admins));
    const filteredAgents = agents.filter(agent => !rejectedAdmins.has(String(agent.username || '').trim()));
    const pool = filteredAgents.length > 0 ? filteredAgents : agents;
    const freeAgents = pool.filter(agent => Number(agent.active_count) === 0);
    const candidatePool = freeAgents.length > 0 ? freeAgents : pool;
    const minLoad = Math.min(...candidatePool.map(agent => Number(agent.active_count) || 0));
    const lowestLoadAgents = candidatePool.filter(agent => (Number(agent.active_count) || 0) === minLoad);
    if (lowestLoadAgents.length === 1) return lowestLoadAgents[0];
    return lowestLoadAgents[Math.floor(Math.random() * lowestLoadAgents.length)] || null;
}

function assignPendingChats() {
    db.all(`SELECT id, rejected_admins FROM chats WHERE is_active = 1 AND (assigned_admin IS NULL OR TRIM(assigned_admin) = '') ORDER BY tarih ASC, id ASC`, [], (err, pendingChats) => {
        if (err || !pendingChats || pendingChats.length === 0) return;

        const assignNext = (index) => {
            if (index >= pendingChats.length) return;
            getAvailableSupportAgents((availableAgents) => {
                if (!availableAgents || availableAgents.length === 0) return;
                const selected = chooseSupportAgentForChat(pendingChats[index], availableAgents);
                if (!selected) return;
                const assignedLabel = (selected.display_name || '').trim() || selected.username;
                db.run(`UPDATE chats SET assigned_admin = ?, assigned_label = ?, assignment_status = 'pending', accepted_at = NULL WHERE id = ? AND (assigned_admin IS NULL OR TRIM(assigned_admin) = '')`, [selected.username, assignedLabel, pendingChats[index].id], function() {
                    if (this.changes > 0) assignNext(index + 1);
                });
            });
        };

        assignNext(0);
    });
}

// ⚠️ OTOMATİK RTP GÜNCELLEME (Sadece auto_rtp = 1 Olan Seçili Oyunlar İçin)
let lastRtpUpdate = 0;
setInterval(() => {
    db.all(`SELECT anahtar, deger FROM settings WHERE anahtar IN ('rtp_random_active')`, [], (err, rows) => {
        let active = false;
        if(rows) { rows.forEach(r => { if(r.anahtar === 'rtp_random_active') active = (r.deger === 'true'); }); }
        if(active) {
            // Her oyun için kendi aralığı ve birimiyle kontrol
            db.all(`SELECT id, auto_rtp_min, auto_rtp_max, auto_rtp_interval, auto_rtp_interval_unit, last_rtp_update FROM sponsors WHERE auto_rtp = 1`, [], (err, sp) => {
                if(sp) sp.forEach(s => {
                    let now = Date.now();
                    let intervalMs = 60000; // default 1 dakika
                    if(s.auto_rtp_interval_unit === 'second') intervalMs = (s.auto_rtp_interval || 5) * 1000;
                    else intervalMs = (s.auto_rtp_interval || 5) * 60000;
                    if(now - s.last_rtp_update >= intervalMs) {
                        const generateRTP = (min, max) => (Math.random() * (max - min) + min).toFixed(1);
                        db.run(`UPDATE sponsors SET rtp = ?, last_rtp_update = ? WHERE id = ?`, [generateRTP(s.auto_rtp_min, s.auto_rtp_max), now, s.id]);
                    }
                });
            });
        }
    });
}, 1000);

app.post('/api/admin/force-rtp', (req, res) => {
    if(!req.session.isAdmin) return res.status(403).end();
    let now = Date.now();
    db.all(`SELECT id, auto_rtp_min, auto_rtp_max FROM sponsors WHERE auto_rtp = 1`, [], (err, sp) => { if(sp) sp.forEach(s => db.run(`UPDATE sponsors SET rtp = ?, last_rtp_update = ? WHERE id = ?`, [(Math.random() * (s.auto_rtp_max - s.auto_rtp_min) + s.auto_rtp_min).toFixed(1), now, s.id])); });
    addLog(req, "Seçili Oyunların RTP Oranları Rastgele Güncellendi");
    res.json({status: "success"});
});

app.post('/api/track-visit', async (req, res) => {
    const context = getClientContext(req);
    setDeviceFingerprintCookie(res, context.deviceFingerprint);
    const location = await resolveLocationFromIp(context.ip);
    findVisitorByContext(context, (err, row) => {
        if (err) return res.json({ status: 'error' });
        if (row) {
            return db.run(
                `UPDATE visitors SET ip = ?, konum = ?, tarayici = ?, cihaz = ?, os_name = ?, device_model = ?, device_details = ?, user_agent = ?, device_fingerprint = COALESCE(NULLIF(?, ''), device_fingerprint), screen_resolution = ?, browser_language = ?, time_zone = ?, referrer_url = ?, network_type = ?, cookie_status = ?, storage_status = ?, tarih = CURRENT_TIMESTAMP WHERE id = ?`,
                [context.ip, location, context.browser, context.device, context.osName, context.deviceModel, context.deviceDetails, context.userAgent, context.deviceFingerprint, context.screenResolution, context.browserLanguage, context.timeZone, context.referrerUrl, context.networkType, context.cookieStatus, context.storageStatus, row.id],
                () => res.json({ status: 'success' })
            );
        }
        db.run(
            `INSERT INTO visitors (ip, konum, tarayici, cihaz, mac, visited_pages, device_fingerprint, os_name, device_model, device_details, user_agent, screen_resolution, browser_language, time_zone, referrer_url, network_type, cookie_status, storage_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [context.ip, location, context.browser, context.device, 'Tarayıcıdan alınamaz', '[]', context.deviceFingerprint, context.osName, context.deviceModel, context.deviceDetails, context.userAgent, context.screenResolution, context.browserLanguage, context.timeZone, context.referrerUrl, context.networkType, context.cookieStatus, context.storageStatus],
            () => res.json({ status: 'success' })
        );
    });
});
app.post('/api/track-details', (req, res) => {
    const context = getClientContext(req);
    const { path, time, isClick } = req.body || {};
    findVisitorByContext(context, (err, row) => {
        if (err || !row) return res.json({ status: 'success' });
        let pages = [];
        try { pages = JSON.parse(row.visited_pages || '[]'); } catch(e){}
        if(isClick) {
            pages.push({ path: path, time: 0, date: new Date().toLocaleTimeString('tr-TR') });
        } else {
            let lastPage = pages.length > 0 ? pages[pages.length - 1] : null;
            if(lastPage && lastPage.path === path && lastPage.time !== undefined) lastPage.time += Number(time) || 0;
            else pages.push({ path: path, time: Number(time) || 0, date: new Date().toLocaleTimeString('tr-TR') });
        }
        db.run(`UPDATE visitors SET visited_pages = ?, tarih = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(pages), row.id], () => res.json({status: 'success'}));
    });
});

// ⚠️ ZİYARETÇİ KAYIT OLURKEN @ İŞARETİ SİLİNİR
app.post('/api/kayit', async (req, res) => { 
    try { 
        let { ad, soyad, telefon, kadi } = req.body; 
        const safePhone = normalizePhoneNumber(telefon);
        kadi = kadi.replace(/[@\s]/g, ''); // @ işareti ve boşluklar silinir
        if (!ad || !soyad || !safePhone || !kadi) return res.json({ status: 'error', msg: 'Tum alanlari doldurun.' });
        if (phoneNumberHasLetters(safePhone)) return res.json({ status: 'error', msg: 'Telefon alanina yazi girilemez.' });
        if (!/\d/.test(safePhone)) return res.json({ status: 'error', msg: 'Telefon alanina gecerli bir numara girin.' });
        const context = getClientContext(req);
        const location = await resolveLocationFromIp(context.ip);
        setDeviceFingerprintCookie(res, context.deviceFingerprint);
        db.run(`INSERT INTO users (ad, soyad, telefon, site_kullanici_adi, ip_adresi, konum, tarayıcı, cihaz, os_name, device_model, device_details, user_agent, device_fingerprint, screen_resolution, browser_language, time_zone, referrer_url, network_type, cookie_status, storage_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [String(ad).trim(), String(soyad).trim(), safePhone, kadi, context.ip, location, context.browser, context.device, context.osName, context.deviceModel, context.deviceDetails, context.userAgent, context.deviceFingerprint, context.screenResolution, context.browserLanguage, context.timeZone, context.referrerUrl, context.networkType, context.cookieStatus, context.storageStatus], () => res.json({ status: 'success' })); 
    } catch(e) { res.json({ status: "error" }); } 
});
app.post('/api/forum-submit', async (req, res) => {
    try {
        const { ad, soyad, telefon, ulasimTercihi } = req.body || {};
        const safePreference = ['arama', 'whatsapp'].includes(String(ulasimTercihi || '').toLowerCase()) ? String(ulasimTercihi).toLowerCase() : '';
        const safePhone = normalizePhoneNumber(telefon);
        if (!ad || !soyad || !safePhone || !safePreference) return res.json({ status: 'error', msg: 'Tum alanlari doldurun.' });
        if (phoneNumberHasLetters(safePhone)) return res.json({ status: 'error', msg: 'Telefon alanina yazi girilemez.' });
        if (!/\d/.test(safePhone)) return res.json({ status: 'error', msg: 'Telefon alanina gecerli bir numara girin.' });
        const context = getClientContext(req);
        const location = await resolveLocationFromIp(context.ip);
        setDeviceFingerprintCookie(res, context.deviceFingerprint);
        db.run(
            `INSERT INTO forum_requests (ad, soyad, telefon, ulasim_tercihi, ip_adresi, konum, tarayici, cihaz, os_name, device_model, device_details, user_agent, device_fingerprint, screen_resolution, browser_language, time_zone, referrer_url, network_type, cookie_status, storage_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [String(ad).trim(), String(soyad).trim(), safePhone, safePreference, context.ip, location, context.browser, context.device, context.osName, context.deviceModel, context.deviceDetails, context.userAgent, context.deviceFingerprint, context.screenResolution, context.browserLanguage, context.timeZone, context.referrerUrl, context.networkType, context.cookieStatus, context.storageStatus],
            () => res.json({ status: 'success' })
        );
    } catch (e) {
        res.json({ status: 'error', msg: 'Kayit alinamadi.' });
    }
});

app.get('/api/texts', (req, res) => db.all(`SELECT * FROM site_texts`, [], (err, r) => res.json(r || [])));
app.post('/api/admin/update-texts', (req, res) => { if(!req.session.isAdmin) return res.status(403).end(); try { Object.keys(req.body).forEach(k => { db.run(`INSERT OR REPLACE INTO site_texts (anahtar, deger) VALUES (?, ?)`, [k, req.body[k]]); }); addLog(req, "Site Metinleri Güncellendi"); res.json({status: "success"}); } catch(e) { res.json({status: "error"}); } });

app.get('/api/sliders', (req, res) => db.all(`SELECT * FROM custom_sliders`, [], (err, r) => res.json(r || [])));
app.post('/api/admin/add-slider', (req, res) => { if(!req.session.isAdmin) return res.status(403).end(); const { id, baslik, renk, yazi, model } = req.body; if(id) db.run(`UPDATE custom_sliders SET baslik=?, renk=?, yazi=?, model=? WHERE id=?`, [baslik, renk || '#ffaa00', yazi || '', model || 'default', id], () => res.json({status: "success"})); else db.run(`INSERT INTO custom_sliders (baslik, renk, yazi, model) VALUES (?, ?, ?, ?)`, [baslik, renk || '#ffaa00', yazi || '', model || 'default'], () => res.json({status: "success"})); });
app.post('/api/admin/delete-slider', (req, res) => { if(!req.session.isAdmin) return res.status(403).end(); db.run(`DELETE FROM custom_sliders WHERE id=?`, [req.body.id], () => { db.run(`UPDATE sponsors SET slider_id=0 WHERE slider_id=?`, [req.body.id]); res.json({status: "success"}); }); });

app.post('/api/chat/send', async (req, res) => {
    try {
        const context = getClientContext(req);
        const ip = context.ip;
        const deviceFingerprint = normalizeDeviceFingerprint(context.deviceFingerprint);
        setDeviceFingerprintCookie(res, context.deviceFingerprint);
        const safeName = normalizeClientField(req.body?.name, 120);
        const safePhone = normalizeClientField(req.body?.phone, 40);
        const safeSubject = normalizeClientField(req.body?.subject, 160);
        const safeMessage = normalizeChatMessage(req.body?.message, 1800);
        const rawAttachment = req.body?.attachment;
        if (!safeMessage && !rawAttachment) return res.json({ status: 'error', msg: 'Mesaj veya dosya ekleyin.' });

        let row = await findLatestChatForClient(context, { onlyActive: true });
        if (!row) {
            if (!safeName || !safePhone || !safeSubject) return res.json({ status: 'error', msg: 'Gorusme bilgileri eksik.' });
            const inserted = await dbRunAsync(`INSERT INTO chats (user_name, user_phone, user_subject, ip, device_fingerprint, mesajlar, assignment_status, rejected_admins) VALUES (?,?,?,?,?,?,?,?)`, [safeName, safePhone, safeSubject, ip, deviceFingerprint, '[]', 'pending', '[]']);
            row = { id: inserted.lastID, mesajlar: '[]', assigned_admin: '', device_fingerprint: deviceFingerprint, assignment_status: 'pending', rejected_admins: '[]' };
        } else if (deviceFingerprint && !normalizeDeviceFingerprint(row.device_fingerprint)) {
            await dbRunAsync(`UPDATE chats SET device_fingerprint = ? WHERE id = ?`, [deviceFingerprint, row.id]);
            row.device_fingerprint = deviceFingerprint;
        }

        const attachment = rawAttachment ? await storeChatAttachment(req, row.id, rawAttachment, 'visitor') : null;
        if (attachment?.error) return res.json({ status: 'error', msg: attachment.error });

        const msgObj = {
            sender: 'user',
            text: safeMessage,
            time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        };
        if (attachment) msgObj.attachment = attachment;

        const msgs = JSON.parse(row.mesajlar || '[]');
        msgs.push(msgObj);
        const nextAssignmentStatus = row.assigned_admin ? (String(row.assignment_status || '').trim() || 'accepted') : 'pending';
        await dbRunAsync(`UPDATE chats SET mesajlar = ?, visitor_typing_at = NULL, assignment_status = ?, tarih = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(msgs), nextAssignmentStatus, row.id]);
        if (!row.assigned_admin) assignPendingChats();
        res.json({ status: 'success', chat_id: row.id, attachment: attachment || null });
    } catch (e) {
        res.json({ status: 'error', msg: 'Mesaj gonderilemedi.' });
    }
});
app.get('/api/chat/get', async (req, res) => {
    try {
        const context = getClientContext(req);
        setDeviceFingerprintCookie(res, context.deviceFingerprint);
        const row = await findLatestChatForClient(context);
        if (row) {
            const chatDate = row.tarih ? new Date(String(row.tarih).replace(' ', 'T') + 'Z') : null;
            const adminTypingDate = row.admin_typing_at ? new Date(String(row.admin_typing_at).replace(' ', 'T') + 'Z') : null;
            const adminTyping = !!(adminTypingDate && !Number.isNaN(adminTypingDate.getTime()) && (Date.now() - adminTypingDate.getTime()) <= 5000);
            const isExpiredClosedChat = Number(row.is_active) === 0 && chatDate && (Date.now() - chatDate.getTime()) >= 10 * 60 * 1000;
            if (isExpiredClosedChat) {
                return res.json({ msgs: [], is_active: 1, assigned_label: '', pending_assignment: false, expired: true });
            }
            const assignmentStatus = String(row.assignment_status || (row.assigned_admin ? 'accepted' : 'pending')).trim() || 'pending';
            const chatAccepted = assignmentStatus === 'accepted';
            return res.json({ msgs: JSON.parse(row.mesajlar || '[]'), is_active: row.is_active, assigned_label: chatAccepted ? (row.assigned_label || '') : '', pending_assignment: Number(row.is_active) === 1 && !chatAccepted, assignment_status: assignmentStatus, expired: false, close_by: row.close_by || '', admin_typing: chatAccepted ? adminTyping : false });
        }
        res.json({ msgs: [], is_active: 1, assigned_label: '', pending_assignment: false, assignment_status: 'pending', expired: false, close_by: '', admin_typing: false });
    } catch (e) {
        res.json({ msgs: [], is_active: 1, assigned_label: '', pending_assignment: false, assignment_status: 'pending', expired: false, close_by: '', admin_typing: false });
    }
});
app.post('/api/chat/typing', async (req, res) => {
    try {
        const context = getClientContext(req);
        const row = await findLatestChatForClient(context, { onlyActive: true });
        if (!row) return res.json({ status: 'success' });
        const isTyping = !!req.body?.typing;
        await dbRunAsync(`UPDATE chats SET visitor_typing_at = ${isTyping ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`, [row.id]);
        res.json({ status: 'success' });
    } catch (e) {
        res.json({ status: 'error' });
    }
});
app.get('/api/chat/file/:token', async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).end();
        const row = await dbGetAsync(
            `SELECT a.*, c.ip, c.device_fingerprint, c.assigned_admin FROM chat_attachments a JOIN chats c ON c.id = a.chat_id WHERE a.token = ? LIMIT 1`,
            [token]
        );
        if (!row) return res.status(404).end();

        const isAdmin = !!req.session?.isAdmin;
        if (isAdmin) {
            if (!canAccessChatRow(req, { assigned_admin: row.assigned_admin })) return res.status(403).end();
        } else {
            const context = getClientContext(req);
            const requestFingerprint = normalizeDeviceFingerprint(context.deviceFingerprint);
            const rowFingerprint = normalizeDeviceFingerprint(row.device_fingerprint);
            const sameFingerprint = requestFingerprint && rowFingerprint && requestFingerprint === rowFingerprint;
            const sameIp = String(context.ip || '').trim() && String(context.ip || '').trim() === String(row.ip || '').trim();
            if (!sameFingerprint && !sameIp) return res.status(403).end();
        }

        const filePath = path.join(CHAT_ATTACHMENT_DIR, row.stored_name || '');
        if (!filePath.startsWith(CHAT_ATTACHMENT_DIR) || !fs.existsSync(filePath)) return res.status(404).end();

        const downloadName = encodeURIComponent(sanitizeAttachmentName(row.original_name || 'dosya'));
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
        res.setHeader('Content-Length', String(Number(row.file_size || 0)));
        res.setHeader('Content-Disposition', `${row.file_kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${downloadName}`);
        fs.createReadStream(filePath).pipe(res);
    } catch (e) {
        res.status(500).end();
    }
});
app.post('/api/chat/close', async (req, res) => {
    try {
        const context = getClientContext(req);
        const row = await findLatestChatForClient(context, { onlyActive: true });
        if (!row) return res.json({ status: 'error' });
        db.run(`UPDATE chats SET is_active = 0, close_by = 'visitor', visitor_typing_at = NULL, admin_typing_at = NULL, tarih = CURRENT_TIMESTAMP WHERE id = ?`, [row.id], () => {
            assignPendingChats();
            res.json({ status: 'success' });
        });
    } catch (e) {
        res.json({ status: 'error' });
    }
});
app.get('/api/admin/chats', (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    const sql = req.session.adminRole === 'superadmin'
        ? `SELECT * FROM chats WHERE assigned_admin = ? OR assigned_admin IS NULL OR TRIM(assigned_admin) = '' ORDER BY is_active DESC, tarih DESC LIMIT 200`
        : `SELECT * FROM chats WHERE assigned_admin = ? ORDER BY is_active DESC, tarih DESC LIMIT 200`;
    const params = [req.session.adminUser];
    db.all(sql, params, (err, r) => res.json(r || []));
});
app.get('/api/admin/support-roster', (req, res) => {
    if(!req.session.isAdmin || (!hasPerm(req, 'support') && req.session.adminRole !== 'superadmin')) return res.status(403).end();
    getSupportRoster((team) => {
        res.json(team || []);
    });
});
app.get('/api/admin/support-active-agents', (req, res) => {
    if(!req.session.isAdmin || (!hasPerm(req, 'support') && req.session.adminRole !== 'superadmin')) return res.status(403).end();
    getSupportRoster((team) => {
        res.json((team || []).filter(agent => agent.active_now));
    });
});
app.post('/api/admin/support-toggle-availability', (req, res) => {
    if(!req.session.isAdmin || (!hasPerm(req, 'support') && req.session.adminRole !== 'superadmin')) return res.status(403).end();
    const nextValue = req.body?.active === false || req.body?.active === 0 || req.body?.active === '0' ? 0 : 1;
    db.run(`UPDATE admins SET support_active = ?, last_seen = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_seen END WHERE username = ?`, [nextValue, nextValue, req.session.adminUser], function() {
        if (!this.changes) return res.json({ status: 'error' });
        assignPendingChats();
        res.json({ status: 'success', active: nextValue === 1 });
    });
});
app.get('/api/admin/chat-archives', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'support_archive')) return res.status(403).end();
    db.all(`SELECT * FROM chats WHERE is_active = 0 AND assigned_admin IS NOT NULL AND TRIM(assigned_admin) != '' ORDER BY tarih DESC LIMIT 500`, [], (err, rows) => {
        res.json(rows || []);
    });
});
app.post('/api/admin/chat/reply', async (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    try {
        const id = Number(req.body?.id);
        const message = normalizeChatMessage(req.body?.message, 1800);
        const rawAttachment = req.body?.attachment;
        if (!message && !rawAttachment) return res.json({ status: 'error', msg: 'Mesaj veya dosya ekleyin.' });
        const row = await dbGetAsync(`SELECT mesajlar, assigned_admin, assignment_status FROM chats WHERE id = ?`, [id]);
        if(!canAccessChatRow(req, row)) return res.status(403).json({status: "forbidden"});
        if (String(row.assignment_status || 'pending') !== 'accepted') return res.json({ status: 'error', msg: 'Önce görüşmeyi kabul edin.' });
        const attachment = rawAttachment ? await storeChatAttachment(req, id, rawAttachment, 'admin') : null;
        if (attachment?.error) return res.json({ status: 'error', msg: attachment.error });
        let msgs = JSON.parse(row.mesajlar || '[]');
        const msgObj = { sender: 'admin', text: message, time: new Date().toLocaleTimeString('tr-TR', {hour: '2-digit', minute:'2-digit'}) };
        if (attachment) msgObj.attachment = attachment;
        msgs.push(msgObj);
        await dbRunAsync(`UPDATE chats SET mesajlar = ?, admin_typing_at = NULL, tarih = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(msgs), id]);
        res.json({status: "success", attachment: attachment || null});
    } catch (e) {
        res.json({status: 'error', msg: 'Mesaj gonderilemedi.'});
    }
});
app.post('/api/admin/chat/typing', async (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    try {
        const id = Number(req.body?.id);
        const row = await dbGetAsync(`SELECT assigned_admin, assignment_status FROM chats WHERE id = ?`, [id]);
        if(!canAccessChatRow(req, row)) return res.status(403).json({status: 'forbidden'});
        if (String(row.assignment_status || 'pending') !== 'accepted') return res.json({ status: 'success' });
        const isTyping = !!req.body?.typing;
        await dbRunAsync(`UPDATE chats SET admin_typing_at = ${isTyping ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`, [id]);
        res.json({ status: 'success' });
    } catch (e) {
        res.json({ status: 'error' });
    }
});
app.post('/api/admin/chat/close', (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    db.get(`SELECT assigned_admin FROM chats WHERE id = ?`, [req.body.id], (err, row) => {
        if(!canAccessChatRow(req, row)) return res.status(403).json({status: "forbidden"});
        db.run(`UPDATE chats SET is_active = 0, close_by = 'admin', visitor_typing_at = NULL, admin_typing_at = NULL, tarih = CURRENT_TIMESTAMP WHERE id = ?`, [req.body.id], () => {
            assignPendingChats();
            res.json({status: "success"});
        });
    });
});
app.post('/api/admin/chat/reassign', async (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    try {
        const chatId = Number(req.body?.id);
        const targetUsername = String(req.body?.targetUsername || '').trim();
        if (!Number.isInteger(chatId) || !targetUsername) return res.json({ status: 'error', msg: 'Geçerli temsilci seçin.' });

        const chatRow = await dbGetAsync(`SELECT id, is_active, assigned_admin, assignment_status, rejected_admins FROM chats WHERE id = ?`, [chatId]);
        if (!chatRow || !canAccessChatRow(req, chatRow)) return res.status(403).json({status: 'forbidden'});
        if (Number(chatRow.is_active) !== 1) return res.json({ status: 'error', msg: 'Sadece aktif görüşmeler aktarılabilir.' });
        if (String(chatRow.assigned_admin || '').trim() === targetUsername) return res.json({ status: 'success' });

        getSupportAgentByUsername(targetUsername, async (targetAgent) => {
            try {
                if (!targetAgent) return res.json({ status: 'error', msg: 'Temsilci bulunamadı.' });
                if (!targetAgent.support_enabled || !targetAgent.active_now) return res.json({ status: 'error', msg: 'Seçilen temsilci şu anda yeni görüşme almıyor.' });

                await dbRunAsync(`UPDATE chats SET assigned_admin = ?, assigned_label = ?, assignment_status = 'accepted', accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP), rejected_admins = '[]', tarih = CURRENT_TIMESTAMP WHERE id = ?`, [targetAgent.username, targetAgent.display_name, chatId]);
                addLog(req, `Canlı destek görüşmesi ${targetAgent.display_name} adlı temsilciye aktarıldı`);
                res.json({ status: 'success', assigned_admin: targetAgent.username, assigned_label: targetAgent.display_name });
            } catch (transferError) {
                res.json({ status: 'error', msg: 'Görüşme aktarılamadı.' });
            }
        });
    } catch (e) {
        res.json({ status: 'error', msg: 'Görüşme aktarılamadı.' });
    }
});
app.post('/api/admin/chat/accept', async (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    try {
        const chatId = Number(req.body?.id);
        const row = await dbGetAsync(`SELECT id, is_active, assigned_admin, assignment_status FROM chats WHERE id = ?`, [chatId]);
        if (!row || !canAccessChatRow(req, row)) return res.status(403).json({ status: 'forbidden' });
        if (Number(row.is_active) !== 1) return res.json({ status: 'error', msg: 'Bu görüşme artık aktif değil.' });
        await dbRunAsync(`UPDATE chats SET assignment_status = 'accepted', accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP), tarih = CURRENT_TIMESTAMP WHERE id = ?`, [chatId]);
        addLog(req, 'Canlı destek görüşmesi kabul edildi');
        res.json({ status: 'success' });
    } catch (e) {
        res.json({ status: 'error', msg: 'Görüşme kabul edilemedi.' });
    }
});
app.post('/api/admin/chat/reject', async (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    try {
        const chatId = Number(req.body?.id);
        const row = await dbGetAsync(`SELECT id, is_active, assigned_admin, rejected_admins FROM chats WHERE id = ?`, [chatId]);
        if (!row || !canAccessChatRow(req, row)) return res.status(403).json({ status: 'forbidden' });
        if (Number(row.is_active) !== 1) return res.json({ status: 'error', msg: 'Bu görüşme artık aktif değil.' });
        const rejectedAdmins = parseRejectedAdmins(row.rejected_admins);
        if (!rejectedAdmins.includes(req.session.adminUser)) rejectedAdmins.push(req.session.adminUser);
        await dbRunAsync(`UPDATE chats SET assigned_admin = '', assigned_label = '', assignment_status = 'pending', admin_typing_at = NULL, rejected_admins = ?, tarih = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(rejectedAdmins), chatId]);
        assignPendingChats();
        addLog(req, 'Canlı destek görüşmesi reddedildi ve başka temsilciye yönlendirildi');
        res.json({ status: 'success' });
    } catch (e) {
        res.json({ status: 'error', msg: 'Görüşme reddedilemedi.' });
    }
});
app.post('/api/admin/chat/delete', (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    db.get(`SELECT is_active, assigned_admin FROM chats WHERE id = ?`, [req.body.id], (err, row) => {
        if(!canAccessChatRow(req, row)) return res.status(403).json({status: "forbidden"});
        if (!row) return res.json({status: "error"});
        if (Number(row.is_active) === 1) return res.json({status: "active_chat"});
        deleteChatAttachments([Number(req.body.id)]).then(() => {
            db.run(`DELETE FROM chats WHERE id = ?`, [req.body.id], function() {
                if (!this.changes) return res.json({status: "error"});
                addLog(req, "Canlı Destek Görüşmesi Silindi");
                res.json({status: "success"});
            });
        }).catch(() => res.json({status: 'error'}));
    });
});
app.post('/api/admin/chat/bulk-delete', (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(id => Number(id)).filter(Number.isInteger) : [];
    if (ids.length === 0) return res.json({status: "error"});
    const placeholders = ids.map(() => '?').join(',');
    if (req.session.adminRole === 'superadmin') {
        db.all(`SELECT id FROM chats WHERE is_active = 0 AND id IN (${placeholders})`, ids, async (selectErr, rows) => {
            if (selectErr) return res.json({status: 'error'});
            const deletableIds = (rows || []).map(item => Number(item.id)).filter(Number.isInteger);
            try {
                await deleteChatAttachments(deletableIds);
            } catch (e) {
                return res.json({status: 'error'});
            }
            db.run(`DELETE FROM chats WHERE is_active = 0 AND id IN (${placeholders})`, ids, function() {
                addLog(req, "Secili Biten Canlı Destek Görüşmeleri Silindi");
                res.json({status: "success", deleted: this.changes || 0});
            });
        });
        return;
    }
    db.all(`SELECT id FROM chats WHERE is_active = 0 AND assigned_admin = ? AND id IN (${placeholders})`, [req.session.adminUser, ...ids], async (selectErr, rows) => {
        if (selectErr) return res.json({status: 'error'});
        const deletableIds = (rows || []).map(item => Number(item.id)).filter(Number.isInteger);
        try {
            await deleteChatAttachments(deletableIds);
        } catch (e) {
            return res.json({status: 'error'});
        }
        db.run(`DELETE FROM chats WHERE is_active = 0 AND assigned_admin = ? AND id IN (${placeholders})`, [req.session.adminUser, ...ids], function() {
            addLog(req, "Secili Biten Canlı Destek Görüşmeleri Silindi");
            res.json({status: "success", deleted: this.changes || 0});
        });
    });
});
app.post('/api/admin/chat/delete-all-closed', async (req, res) => {
    if(!req.session.isAdmin) return res.status(401).end();
    try {
        const rows = await dbAllAsync(
            req.session.adminRole === 'superadmin'
                ? `SELECT id FROM chats WHERE is_active = 0`
                : `SELECT id FROM chats WHERE is_active = 0 AND assigned_admin = ?`,
            req.session.adminRole === 'superadmin' ? [] : [req.session.adminUser]
        );
        const ids = rows.map(row => Number(row.id)).filter(Number.isInteger);
        if (ids.length === 0) return res.json({ status: 'empty', deleted: 0 });
        await deleteChatAttachments(ids);
        const placeholders = ids.map(() => '?').join(',');
        await dbRunAsync(`DELETE FROM chats WHERE id IN (${placeholders})`, ids);
        addLog(req, "Tum Biten Canlı Destek Görüşmeleri Silindi");
        res.json({ status: 'success', deleted: ids.length });
    } catch (e) {
        res.json({ status: 'error', deleted: 0 });
    }
});

app.post('/api/admin/verify-pass', (req, res) => { if(!req.session.isAdmin || req.session.adminRole !== 'superadmin') return res.status(403).end(); db.get(`SELECT id FROM admins WHERE username = ? AND password = ?`, [req.session.adminUser, req.body.password], (err, row) => { res.json({success: !!row}); }); });
app.get('/api/admin/files', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
    try {
        const files = collectAdminEditorFiles(ADMIN_EDITOR_ROOT);
        res.json({ status: 'success', files });
    } catch (e) {
        res.json({ status: 'error', msg: 'Dosya listesi alinamadi.' });
    }
});
app.post('/api/admin/read-file', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
    try {
        const fileInfo = normalizeAdminEditorPath(req.body.filename, { skipExtensionCheck: false });
        const content = fs.readFileSync(fileInfo.absolutePath, 'utf8');
        res.json({ status: 'success', content, filename: fileInfo.relativePath });
    } catch(e) {
        res.json({ status: 'error', msg: 'Dosya okunamadi.' });
    }
});
app.post('/api/admin/write-file', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
    try {
        const fileInfo = normalizeAdminEditorPath(req.body.filename, { skipExtensionCheck: false });
        fs.writeFileSync(fileInfo.absolutePath, String(req.body.content || ''), 'utf8');
        addLog(req, `'${fileInfo.relativePath}' dosyasi duzenlendi`);
        res.json({ status: 'success', filename: fileInfo.relativePath });
    } catch(e) {
        res.json({ status: 'error', msg: 'Dosya kaydedilemedi.' });
    }
});
app.post('/api/admin/create-file', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
    try {
        const fileInfo = normalizeAdminEditorPath(req.body.filename, { skipExtensionCheck: false });
        if (fs.existsSync(fileInfo.absolutePath)) return res.json({ status: 'error', msg: 'Bu dosya zaten var.' });
        fs.mkdirSync(path.dirname(fileInfo.absolutePath), { recursive: true });
        fs.writeFileSync(fileInfo.absolutePath, String(req.body.content || ''), { encoding: 'utf8', flag: 'wx' });
        addLog(req, `'${fileInfo.relativePath}' dosyasi olusturuldu`);
        res.json({ status: 'success', filename: fileInfo.relativePath });
    } catch (e) {
        const msg = e && e.message === 'invalid-file-type'
            ? 'Sadece metin veya kod dosyalari olusturabilirsiniz.'
            : 'Dosya olusturulamadi.';
        res.json({ status: 'error', msg });
    }
});

app.get('/api/settings', (req, res) => db.all(`SELECT * FROM settings`, [], (err, r) => res.json(r || [])));
app.get('/api/menus', (req, res) => {
    db.all(`SELECT * FROM menus ORDER BY id ASC`, [], (err, rows) => {
        const list = Array.isArray(rows) ? [...rows] : [];
        const forumItem = list.find(item => item.link === '/forum');
        if (forumItem) {
            if (forumItem.ad !== 'VIP FORUM') {
                return db.run(`UPDATE menus SET ad = 'VIP FORUM' WHERE link = '/forum'`, () => {
                    res.json(list.map(item => item.link === '/forum' ? { ...item, ad: 'VIP FORUM' } : item));
                });
            }
            return res.json(list);
        }
        db.run(`INSERT INTO menus (ad, link) VALUES ('VIP FORUM', '/forum')`, function() {
            res.json([...list, { id: this?.lastID || 0, ad: 'VIP FORUM', link: '/forum' }]);
        });
    });
});
app.get('/api/sponsors', (req, res) => db.all(`SELECT * FROM sponsors ORDER BY id DESC`, [], (err, r) => res.json(r || []))); 
app.get('/api/oyunlar', (req, res) => res.json([]));
app.get('/api/pages', (req, res) => db.all(`SELECT * FROM pages`, [], (err, r) => res.json(r || []))); 
app.get('/api/pages/:slug', (req, res) => db.get(`SELECT * FROM pages WHERE slug = ?`, [req.params.slug], (err, r) => res.json(r || {})));
app.get('/api/footer-items', (req, res) => db.all(`SELECT * FROM footer_items ORDER BY id ASC`, [], (err, r) => res.json(r || [])));
app.post('/api/security/client-event', (req, res) => {
    const event = buildClientSecurityEvent(req);
    if (!event) return res.status(400).json({ status: 'ignored' });
    logSecurityEvent(req, event);
    res.json({ status: 'ok' });
});

app.get('/api/admin/support-team-chat', async (req, res) => {
    if(!req.session.isAdmin || (!hasPerm(req, 'support') && req.session.adminRole !== 'superadmin')) return res.status(403).end();
    try {
        const rows = await dbAllAsync(`SELECT id, admin_username, admin_label, message, attachment_json, created_at FROM support_team_messages ORDER BY id DESC LIMIT 120`);
        res.json((rows || []).reverse());
    } catch (e) {
        res.json([]);
    }
});
app.post('/api/admin/support-team-chat', async (req, res) => {
    if(!req.session.isAdmin || (!hasPerm(req, 'support') && req.session.adminRole !== 'superadmin')) return res.status(403).end();
    try {
        const message = normalizeChatMessage(req.body?.message, 1200);
        const rawAttachment = req.body?.attachment || null;
        if (!message && !rawAttachment) return res.json({ status: 'error', msg: 'Mesaj veya dosya eklemelisiniz.' });
        const authorLabel = String(req.session.adminDisplayName || req.session.adminUser || 'Destek').trim() || req.session.adminUser;
        const insertResult = await dbRunAsync(`INSERT INTO support_team_messages (admin_username, admin_label, message) VALUES (?, ?, ?)`, [req.session.adminUser, authorLabel, message || '']);
        if (rawAttachment && Number(insertResult?.lastID) > 0) {
            const attachment = await storeSupportTeamAttachment(req, Number(insertResult.lastID), rawAttachment, 'admin');
            if (attachment?.error) {
                await dbRunAsync(`DELETE FROM support_team_messages WHERE id = ?`, [Number(insertResult.lastID)]);
                return res.json({ status: 'error', msg: attachment.error });
            }
            await dbRunAsync(`UPDATE support_team_messages SET attachment_json = ? WHERE id = ?`, [JSON.stringify(attachment), Number(insertResult.lastID)]);
        }
        res.json({ status: 'success' });
    } catch (e) {
        res.json({ status: 'error', msg: 'Mesaj gönderilemedi.' });
    }
});
app.post('/api/admin/support-team-chat/delete', async (req, res) => {
    if(!req.session.isAdmin || req.session.adminRole !== 'superadmin') return res.status(403).json({ status: 'error', msg: 'Bu işlem sadece adminler içindir.' });
    try {
        const id = Number(req.body?.id);
        if (!Number.isInteger(id) || id <= 0) return res.json({ status: 'error', msg: 'Geçersiz mesaj.' });
        const row = await dbGetAsync(`SELECT * FROM support_team_messages WHERE id = ? LIMIT 1`, [id]);
        if (!row) return res.json({ status: 'error', msg: 'Mesaj bulunamadi.' });
        const deletedByLabel = String(req.session.adminDisplayName || req.session.adminUser || 'Admin').trim() || req.session.adminUser;
        await dbRunAsync(
            `INSERT INTO support_team_message_archives (original_message_id, admin_username, admin_label, message, attachment_json, created_at, deleted_by, deleted_by_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.id, row.admin_username, row.admin_label, row.message || '', row.attachment_json || null, row.created_at || null, req.session.adminUser, deletedByLabel]
        );
        await dbRunAsync(`DELETE FROM support_team_messages WHERE id = ?`, [id]);
        res.json({ status: 'success' });
    } catch (e) {
        res.json({ status: 'error', msg: 'Mesaj arşive alınamadı.' });
    }
});
app.post('/api/admin/support-team-chat/bulk-delete', async (req, res) => {
    if(!req.session.isAdmin || req.session.adminRole !== 'superadmin') return res.status(403).json({ status: 'error', msg: 'Bu işlem sadece adminler içindir.' });
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0) : [];
        if (ids.length === 0) return res.json({ status: 'error', msg: 'Silinecek mesaj seçin.' });
        const placeholders = ids.map(() => '?').join(',');
        const rows = await dbAllAsync(`SELECT * FROM support_team_messages WHERE id IN (${placeholders})`, ids);
        if (!rows || rows.length === 0) return res.json({ status: 'error', msg: 'Mesaj bulunamadi.' });
        const deletedByLabel = String(req.session.adminDisplayName || req.session.adminUser || 'Admin').trim() || req.session.adminUser;
        for (const row of rows) {
            await dbRunAsync(
                `INSERT INTO support_team_message_archives (original_message_id, admin_username, admin_label, message, attachment_json, created_at, deleted_by, deleted_by_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.admin_username, row.admin_label, row.message || '', row.attachment_json || null, row.created_at || null, req.session.adminUser, deletedByLabel]
            );
        }
        await dbRunAsync(`DELETE FROM support_team_messages WHERE id IN (${placeholders})`, ids);
        res.json({ status: 'success', count: rows.length });
    } catch (e) {
        res.json({ status: 'error', msg: 'Seçilen mesajlar arşive alınamadı.' });
    }
});
app.post('/api/admin/support-team-chat/delete-all', async (req, res) => {
    if(!req.session.isAdmin || req.session.adminRole !== 'superadmin') return res.status(403).json({ status: 'error', msg: 'Bu işlem sadece adminler içindir.' });
    try {
        const rows = await dbAllAsync(`SELECT * FROM support_team_messages ORDER BY id ASC`, []);
        if (!rows || rows.length === 0) return res.json({ status: 'empty', count: 0 });
        const deletedByLabel = String(req.session.adminDisplayName || req.session.adminUser || 'Admin').trim() || req.session.adminUser;
        for (const row of rows) {
            await dbRunAsync(
                `INSERT INTO support_team_message_archives (original_message_id, admin_username, admin_label, message, attachment_json, created_at, deleted_by, deleted_by_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.admin_username, row.admin_label, row.message || '', row.attachment_json || null, row.created_at || null, req.session.adminUser, deletedByLabel]
            );
        }
        await dbRunAsync(`DELETE FROM support_team_messages`, []);
        res.json({ status: 'success', count: rows.length });
    } catch (e) {
        res.json({ status: 'error', msg: 'Mesajlar arşive alınamadı.' });
    }
});
app.get('/api/admin/support-team-chat/file/:token', async (req, res) => {
    if(!req.session?.isAdmin || (!hasPerm(req, 'support') && req.session.adminRole !== 'superadmin')) return res.status(403).end();
    try {
        const token = String(req.params.token || '').trim();
        if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).end();
        const row = await dbGetAsync(`SELECT * FROM support_team_attachments WHERE token = ? LIMIT 1`, [token]);
        if (!row) return res.status(404).end();
        const filePath = path.join(CHAT_ATTACHMENT_DIR, row.stored_name || '');
        if (!filePath.startsWith(CHAT_ATTACHMENT_DIR) || !fs.existsSync(filePath)) return res.status(404).end();
        const downloadName = encodeURIComponent(sanitizeAttachmentName(row.original_name || 'dosya'));
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
        res.setHeader('Content-Length', String(Number(row.file_size || 0)));
        res.setHeader('Content-Disposition', `${row.file_kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${downloadName}`);
        fs.createReadStream(filePath).pipe(res);
    } catch (e) {
        res.status(500).end();
    }
});
app.get('/api/admin/me', (req, res) => { if(!req.session.isAdmin) return res.status(401).end(); db.get(`SELECT display_name, support_active FROM admins WHERE username = ?`, [req.session.adminUser], (err, row) => { res.json({ username: req.session.adminUser, role: req.session.adminRole, perms: req.session.adminPerms, display_name: row?.display_name || req.session.adminUser, support_active: Number(row?.support_active ?? 1) !== 0 }); }); });
app.get('/api/admin/users', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'view_records')) return res.status(403).end();
    db.all(
        `SELECT id,
                'user' as source,
                'Standart Form' as source_label,
                'user:' || id as record_key,
                ad,
                soyad,
                telefon,
                site_kullanici_adi,
                ip_adresi,
                konum,
                tarayıcı as tarayici,
                cihaz,
                                os_name,
                                device_model,
                                device_details,
                                user_agent,
                                device_fingerprint,
                                screen_resolution,
                                browser_language,
                                time_zone,
                                referrer_url,
                                network_type,
                                cookie_status,
                                storage_status,
                tarih
         FROM users
         WHERE is_archived = 0
         UNION ALL
         SELECT id,
                'forum' as source,
                'VIP FORUM' as source_label,
                'forum:' || id as record_key,
                ad,
                soyad,
                telefon,
                ulasim_tercihi as site_kullanici_adi,
                ip_adresi,
                konum,
                tarayici,
                cihaz,
                                os_name,
                                device_model,
                                device_details,
                                user_agent,
                                device_fingerprint,
                                screen_resolution,
                                browser_language,
                                time_zone,
                                referrer_url,
                                network_type,
                                cookie_status,
                                storage_status,
                tarih
         FROM forum_requests
         WHERE is_archived = 0
         ORDER BY tarih DESC, id DESC`,
        [],
        (err, r) => res.json(r || [])
    );
});
app.get('/api/admin/visitors', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'view_records')) return res.status(403).end();
    db.all(
        `SELECT v.*,
                CASE WHEN EXISTS (
                    SELECT 1 FROM banned_visitors b
                    WHERE (TRIM(COALESCE(b.ip, '')) != '' AND b.ip = v.ip)
                       OR (TRIM(COALESCE(b.device_fingerprint, '')) != '' AND b.device_fingerprint = v.device_fingerprint)
                ) THEN 1 ELSE 0 END AS is_banned,
                COALESCE((
                    SELECT group_concat(b.ban_type)
                    FROM banned_visitors b
                    WHERE (TRIM(COALESCE(b.ip, '')) != '' AND b.ip = v.ip)
                       OR (TRIM(COALESCE(b.device_fingerprint, '')) != '' AND b.device_fingerprint = v.device_fingerprint)
                ), '') AS ban_types
         FROM visitors v
         WHERE v.is_archived = 0
         ORDER BY v.id DESC
         LIMIT 1000`,
        [],
        (err, r) => res.json(r || [])
    );
});
app.get('/api/admin/visitor-extra-details/:id', async (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'view_records')) return res.status(403).end();
    try {
        const visitorId = Number(req.params.id);
        if (!Number.isInteger(visitorId) || visitorId <= 0) return res.json({ status: 'error', msg: 'Geçersiz ziyaretçi.' });
        const visitor = await dbGetAsync(`SELECT id, ip, device_fingerprint FROM visitors WHERE id = ? LIMIT 1`, [visitorId]);
        if (!visitor) return res.json({ status: 'error', msg: 'Ziyaretçi bulunamadı.' });

        const visitorFingerprint = normalizeDeviceFingerprint(visitor.device_fingerprint);
        const visitorIp = String(visitor.ip || '').trim();
        const whereParts = [];
        const params = [];
        if (visitorFingerprint) {
            whereParts.push(`device_fingerprint = ?`);
            params.push(visitorFingerprint);
        }
        if (visitorIp) {
            whereParts.push(`ip = ?`);
            params.push(visitorIp);
        }
        if (whereParts.length === 0) {
            return res.json({ status: 'success', support: { totalChats: 0, activeChats: 0, closedByAdmin: 0, closedByVisitor: 0, recentChats: [] } });
        }

        const chats = await dbAllAsync(
            `SELECT id, user_subject, assigned_label, assigned_admin, is_active, close_by, tarih, mesajlar
             FROM chats
             WHERE ${whereParts.join(' OR ')}
             ORDER BY tarih DESC, id DESC
             LIMIT 25`,
            params
        );

        const recentChats = (chats || []).map(chat => {
            let messages = [];
            try { messages = JSON.parse(chat.mesajlar || '[]'); } catch (e) {}
            const visitorMessages = messages.filter(message => message && message.sender === 'user').length;
            const adminMessages = messages.filter(message => message && message.sender === 'admin').length;
            return {
                id: chat.id,
                subject: chat.user_subject || 'Genel destek',
                assigned_label: (chat.assigned_label || '').trim() || (chat.assigned_admin || '').trim() || 'Atanmadı',
                is_active: Number(chat.is_active) === 1,
                close_by: chat.close_by || '',
                tarih: chat.tarih || '',
                visitor_messages: visitorMessages,
                admin_messages: adminMessages
            };
        });

        res.json({
            status: 'success',
            support: {
                totalChats: recentChats.length,
                activeChats: recentChats.filter(chat => chat.is_active).length,
                closedByAdmin: recentChats.filter(chat => !chat.is_active && chat.close_by === 'admin').length,
                closedByVisitor: recentChats.filter(chat => !chat.is_active && chat.close_by === 'visitor').length,
                recentChats: recentChats.slice(0, 6)
            }
        });
    } catch (e) {
        res.json({ status: 'error', msg: 'Ziyaretçi detayları alınamadı.' });
    }
});
app.get('/api/admin/dashboard-live', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'view_records')) return res.status(403).end();
    db.get(`SELECT COUNT(*) as uCount FROM users`, [], (err, userRow) => {
        db.get(`SELECT COUNT(*) as vCount FROM visitors WHERE is_archived = 0`, [], (err2, visitorRow) => {
            db.get(`SELECT COUNT(*) as activeCount FROM visitors WHERE is_archived = 0 AND tarih >= datetime('now', '-5 minutes')`, [], (err3, activeRow) => {
                db.get(`SELECT COUNT(*) as active15Count FROM visitors WHERE is_archived = 0 AND tarih >= datetime('now', '-15 minutes')`, [], (err4, active15Row) => {
                    db.get(
                        `SELECT COUNT(*) as bannedCount
                         FROM visitors v
                         WHERE v.is_archived = 0 AND EXISTS (
                            SELECT 1 FROM banned_visitors b
                            WHERE (TRIM(COALESCE(b.ip, '')) != '' AND b.ip = v.ip)
                               OR (TRIM(COALESCE(b.device_fingerprint, '')) != '' AND b.device_fingerprint = v.device_fingerprint)
                         )`,
                        [],
                        (err5, bannedRow) => {
                            db.get(`SELECT COUNT(*) as activeChatCount FROM chats WHERE is_active = 1`, [], (err6, chatRow) => {
                                db.get(
                                    `SELECT
                                        SUM(CASE WHEN lower(COALESCE(referrer_url, '')) LIKE '%instagram.%' THEN 1 ELSE 0 END) as instagramCount,
                                        SUM(CASE WHEN lower(COALESCE(referrer_url, '')) LIKE '%t.me%' OR lower(COALESCE(referrer_url, '')) LIKE '%telegram.%' OR lower(COALESCE(referrer_url, '')) LIKE '%telegram.me%' THEN 1 ELSE 0 END) as telegramCount
                                     FROM visitors
                                     WHERE is_archived = 0`,
                                    [],
                                    (err7, sourceRow) => {
                                        db.all(
                                            `SELECT id, ip, konum, tarayici, cihaz, tarih, visited_pages
                                             FROM visitors
                                             WHERE is_archived = 0
                                             ORDER BY id DESC
                                             LIMIT 8`,
                                            [],
                                            (err8, recentVisitors) => {
                                                res.json({
                                                    users: userRow?.uCount || 0,
                                                    visitors: visitorRow?.vCount || 0,
                                                    active: activeRow?.activeCount || 0,
                                                    active15: active15Row?.active15Count || 0,
                                                    banned: bannedRow?.bannedCount || 0,
                                                    activeChats: chatRow?.activeChatCount || 0,
                                                    instagram: sourceRow?.instagramCount || 0,
                                                    telegram: sourceRow?.telegramCount || 0,
                                                    recentVisitors: recentVisitors || []
                                                });
                                            }
                                        );
                                    }
                                );
                            });
                        }
                    );
                });
            });
        });
    });
});
app.get('/api/admin/archives', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_archives')) return res.status(403).end();
    getArchivedRecords().then(rows => res.json(rows || [])).catch(() => res.json([]));
});
app.post('/api/admin/archive-export', async (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_archives')) return res.status(403).end();
    try {
        const rows = filterArchivedRecords(await getArchivedRecords(), req.body?.items);
        if (!rows.length) return res.status(400).json({ status: 'error', msg: 'Aktarilacak arsiv kaydi bulunamadi.' });
        const csv = buildArchiveCsv(rows);
        const fileDate = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="gizli-arsiv-${fileDate}.csv"`);
        addLog(req, `Gizli Arsiv CSV olarak indirildi (${rows.length} kayit)`);
        res.send(`\uFEFF${csv}`);
    } catch (e) {
        res.status(500).json({ status: 'error', msg: 'Arsiv disa aktarilamadi.' });
    }
});
app.post('/api/admin/archive-email', async (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_archives')) return res.status(403).end();
    try {
        const email = sanitizeEmailAddress(req.body?.email);
        if (!email) return res.json({ status: 'error', msg: 'Gecerli bir e-posta adresi girin.' });
        const transporter = createMailerTransport();
        if (!transporter) return res.json({ status: 'error', msg: 'SMTP ayarlari tanimli degil. SMTP_HOST, SMTP_PORT, SMTP_USER ve SMTP_PASS gerekli.' });
        const rows = filterArchivedRecords(await getArchivedRecords(), req.body?.items);
        if (!rows.length) return res.json({ status: 'error', msg: 'Gonderilecek arsiv kaydi bulunamadi.' });
        const csv = buildArchiveCsv(rows);
        const reportDate = new Date().toLocaleString('tr-TR');
        const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
        await transporter.sendMail({
            from: fromAddress,
            to: email,
            subject: `Gizli Arsiv Raporu (${rows.length} kayit)`,
            text: `Gizli arsiv kayitlari ektedir. Rapor tarihi: ${reportDate}`,
            html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;"><h2>Gizli Arsiv Raporu</h2><p>Toplam <b>${rows.length}</b> kayit ektedir.</p><p>Rapor tarihi: ${reportDate}</p></div>`,
            attachments: [{
                filename: `gizli-arsiv-${new Date().toISOString().slice(0, 10)}.csv`,
                content: `\uFEFF${csv}`,
                contentType: 'text/csv; charset=utf-8'
            }]
        });
        addLog(req, `Gizli Arsiv e-posta ile gonderildi (${email})`);
        res.json({ status: 'success' });
    } catch (e) {
        res.json({ status: 'error', msg: 'Arsiv e-posta ile gonderilemedi.' });
    }
});
app.get('/api/admin/stats', (req, res) => { if(!req.session.isAdmin || (req.session.adminRole !== 'superadmin' && !hasPerm(req, 'view_records'))) return res.status(403).end(); db.get("SELECT COUNT(*) as uCount FROM users", (err, r1) => { db.get("SELECT COUNT(*) as vCount FROM visitors", (err, r2) => { db.get("SELECT COUNT(*) as activeCount FROM visitors WHERE tarih >= datetime('now', '-5 minutes')", (err, r3) => { res.json({ users: r1.uCount, visitors: r2.vCount, active: (r3 ? r3.activeCount : 0) }); }); }); }); });
app.get('/api/admin/logs', (req, res) => { if(!req.session.isAdmin || !hasPerm(req, 'system_logs')) return res.status(403).end(); db.all(`SELECT * FROM logs ORDER BY id DESC LIMIT 500`, [], (err, r) => res.json(r || [])); });
app.get('/api/admin/seo-audit', async (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_settings')) return res.status(403).end();
    try {
        const settingsMap = await getSettingsMapAsync();
        const baseUrl = getBaseUrl(req, settingsMap);
        const robotsText = [`User-agent: *`, `Allow: /`, `Sitemap: ${baseUrl}/sitemap.xml`].join('\n');
        const pageRows = await dbAllAsync(`SELECT slug, baslik, resim_url, seo_title, seo_description, seo_keywords, seo_image, seo_canonical, seo_noindex, icerik FROM pages ORDER BY id ASC`);
        const systemPages = [
            { label: 'Ana Sayfa', fileName: 'index.html', seo: getSystemSeoConfig(req, settingsMap, 'index'), routePath: '/', explicitImage: settingsMap.index_seo_image || settingsMap.hero_image || settingsMap.seo_default_image || '' },
            { label: 'Analizler', fileName: 'analizler.html', seo: getSystemSeoConfig(req, settingsMap, 'analizler'), routePath: '/analizler', explicitImage: settingsMap.analizler_seo_image || settingsMap.analiz_image || settingsMap.seo_default_image || '' },
            { label: 'VIP FORUM', fileName: 'forum.html', seo: getSystemSeoConfig(req, settingsMap, 'forum'), routePath: '/forum', explicitImage: settingsMap.forum_seo_image || settingsMap.forum_image || settingsMap.seo_default_image || '' }
        ].map(page => ({ ...page, html: renderHtmlWithSeo(page.fileName, settingsMap, page.seo) }));
        const dynamicPages = pageRows.map(page => {
            const seo = getDynamicSeoConfig(req, settingsMap, page);
            return {
                label: page.baslik || page.slug || 'Dinamik Sayfa',
                fileName: 'page.html',
                seo,
                routePath: `/p/${page.slug}`,
                explicitImage: page.seo_image || page.resim_url || settingsMap.seo_default_image || '',
                html: renderHtmlWithSeo('page.html', settingsMap, seo)
            };
        });
        const sitemapEntries = [
            { routePath: '/', noindex: Number(settingsMap.index_seo_noindex || 0) === 1 },
            { routePath: '/analizler', noindex: Number(settingsMap.analizler_seo_noindex || 0) === 1 },
            { routePath: '/forum', noindex: Number(settingsMap.forum_seo_noindex || 0) === 1 },
            ...pageRows.map(page => ({ routePath: `/p/${page.slug}`, noindex: Number(page.seo_noindex || 0) === 1 }))
        ].filter(entry => !entry.noindex);
        const sitemapRouteSet = new Set(sitemapEntries.map(entry => entry.routePath));
        const reports = [...systemPages, ...dynamicPages].map(page => buildSeoAuditReport({ ...page, listedInSitemap: sitemapRouteSet.has(page.routePath) }));
        const summary = {
            totalPages: reports.length,
            goodPages: reports.filter(item => item.status === 'good').length,
            warningPages: reports.filter(item => item.status === 'warning').length,
            problemPages: reports.filter(item => item.status === 'problem').length,
            indexedPages: reports.filter(item => !item.noindex).length,
            noindexPages: reports.filter(item => item.noindex).length,
            sitemapEntries: sitemapEntries.length,
            baseUrlConfigured: !!String(settingsMap.seo_base_url || '').trim(),
            averageScore: reports.length ? Math.round(reports.reduce((sum, item) => sum + item.score, 0) / reports.length) : 0
        };
        res.json({
            generatedAt: new Date().toISOString(),
            summary,
            resources: {
                baseUrl,
                robots: { ok: /Sitemap:/i.test(robotsText), preview: robotsText },
                sitemap: { ok: sitemapEntries.length > 0, count: sitemapEntries.length }
            },
            pages: reports
        });
    } catch (error) {
        console.error('SEO audit error:', error.message);
        res.status(500).json({ status: 'error', msg: 'SEO denetimi olusturulamadi.' });
    }
});
app.get('/api/admin/security-events', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'security_monitoring')) return res.status(403).end();
    db.all(`SELECT * FROM security_events ORDER BY id DESC LIMIT 500`, [], (err, rows) => res.json(rows || []));
});
app.post('/api/admin/delete-log', (req, res) => { if(!req.session.isAdmin || !hasPerm(req, 'system_logs')) return res.status(403).end(); db.run(`DELETE FROM logs WHERE id = ?`, [req.body.id], () => res.json({status: "success"})); });
app.post('/api/admin/clear-logs', (req, res) => { if(!req.session.isAdmin || !hasPerm(req, 'system_logs')) return res.status(403).end(); db.run(`DELETE FROM logs`, [], () => { addLog(req, "Tüm Loglar Temizlendi"); res.json({status: "success"}); }); });
app.post('/api/admin/clear-security-events', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'security_monitoring')) return res.status(403).end();
    db.run(`DELETE FROM security_events`, [], () => {
        addLog(req, 'Guvenlik izleme kayitlari temizlendi');
        res.json({status: 'success'});
    });
});
app.get('/api/admin/admins-list', (req, res) => { if(!req.session.isAdmin || req.session.adminRole !== 'superadmin') return res.status(403).end(); db.all(`SELECT id, username, role, perms, display_name FROM admins ORDER BY id ASC`, [], (err, r) => res.json(r || [])); });
app.post('/api/admin/force-logout', (req, res) => {
    if(!req.session.isAdmin || req.session.adminRole !== 'superadmin') return res.status(403).end();
    const targetId = Number(req.body.id);
    if (!Number.isInteger(targetId)) return res.json({status: 'error', msg: 'Geçersiz kullanıcı!'});
    db.get(`SELECT id, username, role FROM admins WHERE id = ?`, [targetId], (err, row) => {
        if (err || !row) return res.json({status: 'error', msg: 'Kullanıcı bulunamadı!'});
        if (row.role === 'superadmin') return res.json({status: 'error', msg: 'Kurucu hesap sistemden atılamaz!'});
        if (row.username === req.session.adminUser) return res.json({status: 'error', msg: 'Kendi oturumunuzu bu işlemle sonlandıramazsınız!'});
        db.run(`UPDATE admins SET session_version = COALESCE(session_version, 0) + 1, force_logout_message = ? WHERE id = ?`, ['Yönetim tarafından sistemden çıkarıldınız.', row.id], function(updateErr) {
            if (updateErr) return res.json({status: 'error', msg: 'Sistemden atma işlemi başarısız oldu!'});
            addLog(req, `'${row.username}' isimli Moderatör Sistemden Atıldı`);
            res.json({status: 'success'});
        });
    });
});

app.post('/api/admin/update-settings', (req, res) => { if(!req.session.isAdmin || !hasPerm(req, 'manage_settings')) return res.status(403).end(); try { const payload = { ...req.body }; if (req.session.adminRole !== 'superadmin') { delete payload.chat_agent_name; delete payload.live_chat_active; delete payload.whatsapp_no; } Object.keys(payload).forEach(k => db.run(`INSERT OR REPLACE INTO settings (anahtar, deger) VALUES (?, ?)`, [k, payload[k]])); addLog(req, "Ayarlar Güncellendi"); res.json({status: "success"}); } catch(e) { res.json({status: "error"}); } });
app.get('/api/admin/ai-config', async (req, res) => {
    if (!req.session.isAdmin || !hasPerm(req, 'ai_workspace')) return res.status(403).end();
    try {
        const config = await getAiConfigAsync();
        const preset = getAiProviderPreset(config.ai_provider);
        res.json({
            status: 'success',
            can_manage: req.session.adminRole === 'superadmin',
            configured: !!(config.ai_api_key && config.ai_base_url),
            provider_presets: ['openai', 'openrouter', 'gemini', 'anthropic', 'groq', 'together', 'mistral', 'fireworks', 'perplexity', 'openai_compatible'],
            ai_provider: config.ai_provider,
            ai_base_url: req.session.adminRole === 'superadmin' ? config.ai_base_url : '',
            ai_api_key: req.session.adminRole === 'superadmin' ? config.ai_api_key : '',
            ai_model: config.ai_model,
            ai_default_base_url: preset.endpoint,
            ai_default_model: preset.defaultModel,
            ai_system_prompt: config.ai_system_prompt,
            ai_temperature: config.ai_temperature
        });
    } catch (error) {
        res.status(500).json({ status: 'error', msg: 'AI ayarlari okunamadi.' });
    }
});
app.post('/api/admin/update-ai-config', (req, res) => {
    if (!req.session.isAdmin || req.session.adminRole !== 'superadmin') return res.status(403).end();
    const provider = String(req.body.ai_provider || 'openai').trim() || 'openai';
    const payload = {
        ai_provider: provider,
        ai_base_url: String(req.body.ai_base_url || '').trim(),
        ai_api_key: String(req.body.ai_api_key || '').trim(),
        ai_model: String(req.body.ai_model || getAiProviderPreset(provider).defaultModel || 'gpt-5.4').trim() || getAiProviderPreset(provider).defaultModel || 'gpt-5.4',
        ai_system_prompt: String(req.body.ai_system_prompt || '').trim(),
        ai_temperature: String(req.body.ai_temperature || '0.7').trim() || '0.7'
    };
    Object.entries(payload).forEach(([key, value]) => {
        db.run(`INSERT OR REPLACE INTO secure_settings (anahtar, deger) VALUES (?, ?)`, [key, value]);
    });
    addLog(req, 'Yapay zeka calisma alani ayarlari guncellendi');
    res.json({ status: 'success' });
});
app.post('/api/admin/ai-chat', async (req, res) => {
    if (!req.session.isAdmin || !hasPerm(req, 'ai_workspace')) return res.status(403).end();
    try {
        const config = await getAiConfigAsync();
        const conversation = sanitizeAiMessages(req.body.messages);
        const prompt = String(req.body.prompt || '').trim();
        const modelOverride = String(req.body.model || '').trim();
        const systemPrompt = String(config.ai_system_prompt || '').trim();
        const finalMessages = [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            ...conversation,
            ...(prompt ? [{ role: 'user', content: prompt }] : [])
        ].slice(-21);
        if (finalMessages.filter(item => item.role === 'user').length === 0) {
            return res.status(400).json({ status: 'error', msg: 'Gonderilecek bir istem bulunamadi.' });
        }
        const reply = await requestAiChatCompletion(config, finalMessages, modelOverride);
        addLog(req, `Yapay zeka calisma alaninda ${modelOverride || config.ai_model} modeli kullanildi`);
        res.json({ status: 'success', reply, model: modelOverride || config.ai_model });
    } catch (error) {
        const providerMessage = error?.response?.data?.error?.message || error?.message || 'AI istegi sirasinda bir hata olustu.';
        res.status(500).json({ status: 'error', msg: providerMessage });
    }
});
app.post('/api/admin/archive', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_archives')) return res.status(403).end();
    const { id, type } = req.body;
    const table = type === 'forum' ? 'forum_requests' : (type === 'user' ? 'users' : 'visitors');
    const label = type === 'forum' ? 'VIP FORUM Kaydı' : (type === 'user' ? 'Form Kaydı' : 'Ziyaretçi');
    db.run(`UPDATE ${table} SET is_archived = 1 WHERE id = ?`, [id], () => {
        addLog(req, `${label} Arşive Kaldırıldı`);
        res.json({status: "success"});
    });
});
app.post('/api/admin/delete-record', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_archives')) return res.status(403).end();
    const { id, type } = req.body;
    const table = type === 'forum' ? 'forum_requests' : (type === 'user' ? 'users' : 'visitors');
    const label = type === 'forum' ? 'VIP FORUM Kaydı' : (type === 'user' ? 'Form Kaydı' : 'Ziyaretçi');
    db.run(`DELETE FROM ${table} WHERE id = ?`, [id], () => {
        addLog(req, `${label} Silindi`);
        res.json({status: "success"});
    });
});
app.post('/api/admin/bulk-delete-archives', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_archives')) return res.status(403).end();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const grouped = { user: [], forum: [], visitor: [] };
    items.forEach(item => {
        const type = String(item?.type || '').trim();
        const id = Number(item?.id);
        if (['user', 'forum', 'visitor'].includes(type) && Number.isInteger(id)) grouped[type].push(id);
    });
    const tasks = Object.entries(grouped)
        .filter(([, ids]) => ids.length > 0)
        .map(([type, ids]) => new Promise(resolve => {
            const table = type === 'forum' ? 'forum_requests' : (type === 'user' ? 'users' : 'visitors');
            const placeholders = ids.map(() => '?').join(',');
            db.run(`DELETE FROM ${table} WHERE is_archived = 1 AND id IN (${placeholders})`, ids, function() {
                resolve(this.changes || 0);
            });
        }));
    Promise.all(tasks).then(results => {
        const total = results.reduce((sum, value) => sum + value, 0);
        addLog(req, `Gizli Arsivden kayitlar silindi (${total} kayit)`);
        res.json({ status: 'success', deleted: total });
    }).catch(() => res.json({ status: 'error', msg: 'Arsiv kayitlari silinemedi.' }));
});
app.post('/api/admin/ban-visitor', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_archives')) return res.status(403).end();
    const visitorId = Number(req.body.id);
    const mode = req.body.mode === 'ip' || req.body.mode === 'device' ? req.body.mode : 'both';
    const reason = String(req.body.reason || 'Yönetim tarafından engellendi.').trim().slice(0, 250);
    if (!Number.isInteger(visitorId)) return res.json({ status: 'error', msg: 'Geçersiz ziyaretçi!' });

    db.get(`SELECT * FROM visitors WHERE id = ?`, [visitorId], (err, visitor) => {
        if (err || !visitor) return res.json({ status: 'error', msg: 'Ziyaretçi bulunamadı!' });

        const fingerprint = normalizeDeviceFingerprint(visitor.device_fingerprint);
        const ops = [];
        if ((mode === 'ip' || mode === 'both') && visitor.ip) ops.push({ banType: 'ip', ip: visitor.ip, fingerprint: '' });
        if ((mode === 'device' || mode === 'both') && fingerprint) ops.push({ banType: 'device', ip: '', fingerprint });
        if (ops.length === 0) return res.json({ status: 'error', msg: 'Banlanacak cihaz bilgisi yok!' });

        const runOperation = (index) => {
            if (index >= ops.length) {
                addLog(req, `Ziyaretçi banlandı (${visitor.ip})`);
                return res.json({ status: 'success' });
            }
            const current = ops[index];
            const deleteSql = current.banType === 'ip'
                ? `DELETE FROM banned_visitors WHERE ban_type = 'ip' AND ip = ?`
                : `DELETE FROM banned_visitors WHERE ban_type = 'device' AND device_fingerprint = ?`;
            const deleteParam = current.banType === 'ip' ? current.ip : current.fingerprint;
            db.run(deleteSql, [deleteParam], () => {
                db.run(
                    `INSERT INTO banned_visitors (ip, device_fingerprint, ban_type, reason, created_by) VALUES (?,?,?,?,?)`,
                    [current.ip, current.fingerprint, current.banType, reason, req.session.adminUser || 'admin'],
                    () => runOperation(index + 1)
                );
            });
        };

        runOperation(0);
    });
});
app.post('/api/admin/unban-visitor', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_archives')) return res.status(403).end();
    const visitorId = Number(req.body.id);
    const mode = req.body.mode === 'ip' || req.body.mode === 'device' ? req.body.mode : 'both';
    if (!Number.isInteger(visitorId)) return res.json({ status: 'error', msg: 'Geçersiz ziyaretçi!' });

    db.get(`SELECT * FROM visitors WHERE id = ?`, [visitorId], (err, visitor) => {
        if (err || !visitor) return res.json({ status: 'error', msg: 'Ziyaretçi bulunamadı!' });

        const fingerprint = normalizeDeviceFingerprint(visitor.device_fingerprint);
        const conditions = [];
        const params = [];
        if ((mode === 'ip' || mode === 'both') && visitor.ip) {
            conditions.push(`(ban_type = 'ip' AND ip = ?)`);
            params.push(visitor.ip);
        }
        if ((mode === 'device' || mode === 'both') && fingerprint) {
            conditions.push(`(ban_type = 'device' AND device_fingerprint = ?)`);
            params.push(fingerprint);
        }
        if (conditions.length === 0) return res.json({ status: 'error', msg: 'Kaldırılacak ban kaydı yok!' });

        db.run(`DELETE FROM banned_visitors WHERE ${conditions.join(' OR ')}`, params, function() {
            addLog(req, `Ziyaretçi banı kaldırıldı (${visitor.ip})`);
            res.json({ status: 'success', deleted: this.changes || 0 });
        });
    });
});
app.post('/api/admin/send-visitor-messagebox', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_archives')) return res.status(403).end();
    const visitorId = Number(req.body.id);
    const title = String(req.body.title || 'Yonetim Mesaji').trim().slice(0, 80);
    const message = String(req.body.message || '').trim().slice(0, 1200);
    const messageType = ['success', 'error', 'info'].includes(String(req.body.messageType || '').trim()) ? String(req.body.messageType).trim() : 'info';
    if (!Number.isInteger(visitorId)) return res.json({ status: 'error', msg: 'Gecersiz ziyaretçi!' });
    if (!message) return res.json({ status: 'error', msg: 'Mesaj metni zorunludur.' });

    db.get(`SELECT id, ip, device_fingerprint FROM visitors WHERE id = ?`, [visitorId], (err, visitor) => {
        if (err || !visitor) return res.json({ status: 'error', msg: 'Ziyaretçi bulunamadi!' });
        const fingerprint = normalizeDeviceFingerprint(visitor.device_fingerprint);
        if (!fingerprint) return res.json({ status: 'error', msg: 'Bu ziyaretçi için cihaz izi bulunamadi.' });
        db.run(
            `INSERT INTO visitor_messagebox_queue (visitor_id, device_fingerprint, title, message, message_type, created_by) VALUES (?,?,?,?,?,?)`,
            [visitor.id, fingerprint, title || 'Yonetim Mesaji', message, messageType, req.session.adminUser || 'admin'],
            function(insertErr) {
                if (insertErr) return res.json({ status: 'error', msg: 'Mesaj gonderilemedi.' });
                addLog(req, `Ziyaretçiye messagebox gönderildi (${visitor.ip || 'IP yok'})`);
                res.json({ status: 'success', id: this.lastID });
            }
        );
    });
});
app.get('/api/visitor-messagebox', (req, res) => {
    const context = getClientContext(req);
    setDeviceFingerprintCookie(res, context.deviceFingerprint);
    const fingerprint = normalizeDeviceFingerprint(context.deviceFingerprint);
    if (!fingerprint) return res.json({ status: 'empty' });
    db.get(
        `SELECT * FROM visitor_messagebox_queue WHERE device_fingerprint = ? AND is_delivered = 0 ORDER BY id ASC LIMIT 1`,
        [fingerprint],
        (err, row) => {
            if (err || !row) return res.json({ status: 'empty' });
            db.run(`UPDATE visitor_messagebox_queue SET is_delivered = 1, delivered_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id], () => {
                res.json({
                    status: 'success',
                    messagebox: {
                        id: row.id,
                        title: row.title || 'Yonetim Mesaji',
                        message: row.message || '',
                        type: row.message_type || 'info'
                    }
                });
            });
        }
    );
});

app.post('/api/admin/add-menu-page', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_cms')) return res.status(403).end();
    try {
        let { page_id, menu_id, ad, menu_ad, icerik, resim_url, slug, bg_color, box_color, bg_type, bg_images, bg_effect, bg_speed, bg_scale, bg_size_num, bg_size_unit, img_size, img_opacity, img_anim, layout_json, seo_title, seo_description, seo_keywords, seo_image, seo_canonical, seo_noindex } = req.body;
        ad = ad || 'Yeni Sayfa';
        menu_ad = menu_ad || ad;
        icerik = icerik || '';
        resim_url = resim_url || '';
        seo_title = seo_title || '';
        seo_description = seo_description || '';
        seo_keywords = seo_keywords || '';
        seo_image = seo_image || '';
        seo_canonical = seo_canonical || '';
        seo_noindex = Number(seo_noindex) === 1 ? 1 : 0;
        bg_color = bg_color || '#0a0a0c';
        box_color = box_color || 'rgba(20,20,25,0.8)';
        img_size = img_size || '110';
        img_opacity = img_opacity || '1';
        img_anim = img_anim || 'float';
        bg_size_num = bg_size_num || '100';
        bg_size_unit = bg_size_unit || '%';
        layout_json = typeof layout_json === 'string' && layout_json.trim() ? layout_json : '[]';
        slug = String(slug ? slug : ad).replace(/\s+/g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '');
        const link = '/p/' + slug;

        if (page_id && menu_id) {
            db.run(
                `UPDATE pages SET baslik=?, slug=?, icerik=?, resim_url=?, bg_color=?, box_color=?, bg_type=?, bg_images=?, bg_effect=?, bg_speed=?, bg_scale=?, bg_size_num=?, bg_size_unit=?, img_size=?, img_opacity=?, img_anim=?, layout_json=?, seo_title=?, seo_description=?, seo_keywords=?, seo_image=?, seo_canonical=?, seo_noindex=? WHERE id=?`,
                [ad, slug, icerik, resim_url, bg_color, box_color, bg_type, bg_images, bg_effect, bg_speed, bg_scale, bg_size_num, bg_size_unit, img_size, img_opacity, img_anim, layout_json, seo_title, seo_description, seo_keywords, seo_image, seo_canonical, seo_noindex, page_id],
                () => {
                    db.run(`UPDATE menus SET ad=?, link=? WHERE id=?`, [menu_ad, link, menu_id], () => {
                        addLog(req, `'${ad}' başlıklı sayfa '${menu_ad}' menüsüyle düzenlendi`);
                        res.json({status: 'success'});
                    });
                }
            );
            return;
        }

        db.run(
            `INSERT INTO pages (baslik, slug, icerik, resim_url, bg_color, box_color, bg_type, bg_images, bg_effect, bg_speed, bg_scale, bg_size_num, bg_size_unit, img_size, img_opacity, img_anim, layout_json, seo_title, seo_description, seo_keywords, seo_image, seo_canonical, seo_noindex) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ad, slug, icerik, resim_url, bg_color, box_color, bg_type, bg_images, bg_effect, bg_speed, bg_scale, bg_size_num, bg_size_unit, img_size, img_opacity, img_anim, layout_json, seo_title, seo_description, seo_keywords, seo_image, seo_canonical, seo_noindex],
            () => {
                db.run(`INSERT INTO menus (ad, link) VALUES (?, ?)`, [menu_ad, link], () => {
                    addLog(req, `'${ad}' başlıklı yeni sayfa '${menu_ad}' menüsüyle oluşturuldu`);
                    res.json({status: 'success'});
                });
            }
        );
    } catch(e) {
        res.json({status: 'error'});
    }
});
app.post('/api/admin/delete-menu', (req, res) => { if(!req.session.isAdmin || !hasPerm(req, 'manage_cms')) return res.status(403).end(); db.get(`SELECT ad, link FROM menus WHERE id = ?`, [req.body.id], (err, row) => { if (row && row.link && row.link.startsWith('/p/')) { let slug = row.link.replace('/p/', ''); db.run(`DELETE FROM pages WHERE slug = ?`, [slug]); } db.run(`DELETE FROM menus WHERE id = ?`, [req.body.id], () => { addLog(req, `'${row?row.ad:'Bilinmeyen'}' isimli Sayfa Silindi`); res.json({status: "success"}); }); }); });
app.post('/api/admin/add-footer-item', (req, res) => { if(!req.session.isAdmin || !hasPerm(req, 'manage_cms')) return res.status(403).end(); db.run(`INSERT INTO footer_items (tip, icerik, renk, link_url, hedef) VALUES (?, ?, ?, ?, ?)`, [req.body.tip, req.body.icerik, req.body.renk, req.body.link_url, req.body.hedef || '_self'], () => { addLog(req, `Footer alanına yeni öğe eklendi`); res.json({status: "success"}); }); });
app.post('/api/admin/delete-footer-item', (req, res) => { if(!req.session.isAdmin || !hasPerm(req, 'manage_cms')) return res.status(403).end(); db.run(`DELETE FROM footer_items WHERE id = ?`, [req.body.id], () => { addLog(req, `Footer öğesi silindi`); res.json({status: "success"}); }); });

// Oyun için otomatik RTP aralığı birimi desteği (saniye/dakika)
app.post('/api/admin/add-sponsor', (req, res) => {
    if(!req.session.isAdmin || !hasPerm(req, 'manage_games')) return res.status(403).end();
    const { id, isim, saglayici, link, resimler, rtp, bilgi, slider_id, auto_rtp, auto_rtp_min, auto_rtp_max, auto_rtp_interval, auto_rtp_interval_unit } = req.body;
    const normalizedSliderId = Number(slider_id);
    if (!Number.isInteger(normalizedSliderId) || normalizedSliderId <= 0) {
        return res.status(400).json({status: 'error', msg: 'Kategori seçmeden oyun paylaşamazsınız.'});
    }
    if(id) {
        db.run(`UPDATE sponsors SET isim=?, saglayici=?, link=?, resimler=?, rtp=?, bilgi=?, slider_id=?, auto_rtp=?, auto_rtp_min=?, auto_rtp_max=?, auto_rtp_interval=?, auto_rtp_interval_unit=? WHERE id=?`,
            [isim, saglayici || '', link, resimler, rtp, bilgi, normalizedSliderId, auto_rtp||0, auto_rtp_min||70, auto_rtp_max||99, auto_rtp_interval||5, auto_rtp_interval_unit||'minute', id],
            () => { addLog(req, `'${isim}' Sponsoru Güncellendi`); res.json({status: "success"}); });
    } else {
        db.run(`INSERT INTO sponsors (isim, saglayici, link, resimler, rtp, bilgi, slider_id, auto_rtp, auto_rtp_min, auto_rtp_max, auto_rtp_interval, auto_rtp_interval_unit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [isim, saglayici || '', link, resimler, rtp, bilgi, normalizedSliderId, auto_rtp||0, auto_rtp_min||70, auto_rtp_max||99, auto_rtp_interval||5, auto_rtp_interval_unit||'minute'],
            () => { addLog(req, `'${isim}' Sponsoru Eklendi`); res.json({status: "success"}); });
    }
});
app.post('/api/admin/delete-sponsor', (req, res) => { if(!req.session.isAdmin || !hasPerm(req, 'manage_games')) return res.status(403).end(); db.run(`DELETE FROM sponsors WHERE id = ?`, [req.body.id], () => { addLog(req, `Bir Sponsor Silindi`); res.json({status: "success"}); }); });

app.post('/api/admin/save-admin', (req, res) => { if(!req.session.isAdmin || req.session.adminRole !== 'superadmin') return res.status(403).end(); const { username, password, perms, display_name } = req.body; const displayName = String(display_name || '').trim() || username; db.run(`INSERT INTO admins (username, password, role, perms, display_name) VALUES (?, ?, 'moderator', ?, ?)`, [username, password, JSON.stringify(perms || []), displayName], (err) => { if(err) return res.json({status: "error", msg:"Kullanıcı adı zaten var veya hata oluştu!"}); addLog(req, `'${username}' isimli Moderatör Oluşturuldu`); res.json({status: "success"}); }); });
app.post('/api/admin/edit-admin', (req, res) => {
    if (!req.session.isAdmin) return res.status(403).end();
    const { id, username, password, role, perms, display_name } = req.body;
    // Sadece superadmin başkasını güncelleyebilir, moderatör sadece kendi hesabını güncelleyebilir
    db.get('SELECT * FROM admins WHERE id = ?', [id], (err, adminRow) => {
        if (err || !adminRow) return res.json({ status: 'error', msg: 'Kullanıcı bulunamadı!' });
        const nextDisplayName = String(display_name || '').trim() || username || adminRow.username;
        const requestedRole = String(role || adminRow.role || 'moderator').trim() || 'moderator';
        if (adminRow.role === 'moderator' && username !== adminRow.username) {
            return res.json({ status: 'error', msg: 'Moderatör kullanıcı adı değiştirilemez!' });
        }
        // Başkasını güncellemeye çalışıyorsa ve superadmin değilse engelle
        if (adminRow.username !== req.session.adminUser && req.session.adminRole !== 'superadmin') {
            return res.status(403).json({ status: 'error', msg: 'Yetkiniz yok!' });
        }
        if (req.session.adminRole === 'superadmin' && adminRow.username === req.session.adminUser && requestedRole !== 'superadmin') {
            return res.json({ status: 'error', msg: 'Kendi hesabınızı moderatöre düşüremezsiniz!' });
        }
        const continueUpdate = () => {
        // Moderatör kendi rolünü değiştiremesin, sadece şifre ve kullanıcı adı ve perms güncelleyebilsin
        let sql, params;
        if (req.session.adminRole !== 'superadmin') {
            // Rol değişikliğine izin verme
            if (password) {
                sql = 'UPDATE admins SET username = ?, password = ?, perms = ?, display_name = ? WHERE id = ?';
                params = [username, password, JSON.stringify(perms || []), nextDisplayName, id];
            } else {
                sql = 'UPDATE admins SET username = ?, perms = ?, display_name = ? WHERE id = ?';
                params = [username, JSON.stringify(perms || []), nextDisplayName, id];
            }
        } else {
            // Superadmin her şeyi değiştirebilir
            sql = 'UPDATE admins SET username = ?, role = ?, perms = ?, display_name = ? WHERE id = ?';
            params = [username, requestedRole, JSON.stringify(perms || []), nextDisplayName, id];
            if (password) {
                sql = 'UPDATE admins SET username = ?, password = ?, role = ?, perms = ?, display_name = ? WHERE id = ?';
                params = [username, password, requestedRole, JSON.stringify(perms || []), nextDisplayName, id];
            }
        }
        db.run(sql, params, (err) => {
            if (err) return res.json({ status: 'error', msg: 'Güncelleme hatası!' });
            db.run(`UPDATE chats SET assigned_admin = ?, assigned_label = ? WHERE assigned_admin = ?`, [username, nextDisplayName, adminRow.username]);
            addLog(req, `'${username}' isimli Yönetici Güncellendi`);
            // Eğer kendi kullanıcı adını güncellediyse session'ı da güncelle
            if (adminRow.username === req.session.adminUser && username !== req.session.adminUser) {
                req.session.adminUser = username;
            }
            res.json({ status: 'success' });
        });
        };
        if (adminRow.role === 'superadmin' && requestedRole !== 'superadmin') {
            db.get(`SELECT COUNT(*) as count FROM admins WHERE role = 'superadmin'`, [], (countErr, countRow) => {
                if (countErr) return res.json({ status: 'error', msg: 'Rol degisikligi denetlenemedi!' });
                if (Number(countRow?.count || 0) <= 1) return res.json({ status: 'error', msg: 'Sistemde en az bir superadmin kalmalidir!' });
                continueUpdate();
            });
            return;
        }
        continueUpdate();
    });
});
app.post('/api/admin/delete-admin', (req, res) => {
    if(!req.session.isAdmin || req.session.adminRole !== 'superadmin') return res.status(403).end();
    const targetId = Number(req.body.id);
    if (!Number.isInteger(targetId)) return res.json({status: 'error', msg: 'Geçersiz kullanıcı!'});
    db.get(`SELECT id, username, role FROM admins WHERE id = ?`, [targetId], (err, row) => {
        if (err || !row) return res.json({status: 'error', msg: 'Kullanıcı bulunamadı!'});
        if (row.role === 'superadmin') return res.json({status: 'error', msg: 'Kurucu hesap silinemez!'});
        db.run(`DELETE FROM admins WHERE id = ?`, [row.id], function(deleteErr) {
            if (deleteErr) return res.json({status: 'error', msg: 'Moderatör silinemedi!'});
            addLog(req, `'${row.username}' isimli Moderatör Silindi`);
            res.json({status: 'success'});
        });
    });
});
app.post('/api/admin/change-password', (req, res) => { if(!req.session.isAdmin) return res.status(401).end(); const { username, password, oldPassword, displayName } = req.body; db.get(`SELECT * FROM admins WHERE username = ? AND password = ?`, [req.session.adminUser, oldPassword], (err, row) => { if(!row) return res.json({status: "error", msg: "Eski şifreniz yanlış!"}); const previousUsername = req.session.adminUser; const nextUsername = row.role === 'moderator' ? previousUsername : username; const nextDisplayName = String(displayName || '').trim() || row.display_name || nextUsername; let sql = `UPDATE admins SET username=?, display_name=? WHERE username=?`; let params = [nextUsername, nextDisplayName, previousUsername]; if (password) { sql = `UPDATE admins SET username=?, password=?, display_name=? WHERE username=?`; params = [nextUsername, password, nextDisplayName, previousUsername]; } db.run(sql, params, () => { req.session.adminUser = nextUsername; db.run(`UPDATE chats SET assigned_admin = ?, assigned_label = ? WHERE assigned_admin = ?`, [nextUsername, nextDisplayName, previousUsername]); addLog(req, row.role === 'moderator' ? `Kendi Bilgilerini Güncelledi` : `Kendi Şifresini/Kullanıcı Adını Güncelledi`); res.json({status: "success"}); }); }); });
    // New GitHub API routes
    app.get('/api/admin/github/status', async (req, res) => {
        if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
        const githubSession = req.session.githubAuth || {};
        let repo = null;
        try {
            if (githubSession.accessToken && isGitHubOAuthConfigured()) {
                repo = await getGitHubRepoContext(githubSession.accessToken);
            }
        } catch (e) {
            req.session.githubAuth = null;
        }
        res.json({
            configured: isGitHubOAuthConfigured(),
            connected: !!(req.session.githubAuth && req.session.githubAuth.accessToken),
            repo: repo ? { fullName: repo.fullName, defaultBranch: repo.defaultBranch, private: repo.private, htmlUrl: repo.htmlUrl } : { fullName: GITHUB_OAUTH_CONFIG.repo || '', defaultBranch: '', private: false, htmlUrl: '' },
            user: req.session.githubAuth?.user || null
        });
    });
    
    app.get('/api/admin/github/connect', (req, res) => {
        if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
        if (!isGitHubOAuthConfigured()) return res.redirect('/admin?github=not-configured');
        const state = crypto.randomBytes(24).toString('hex');
        req.session.githubOAuthState = state;
        const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(GITHUB_OAUTH_CONFIG.clientId)}&redirect_uri=${encodeURIComponent(getGitHubRedirectUri())}&scope=${encodeURIComponent(GITHUB_OAUTH_CONFIG.scope)}&state=${encodeURIComponent(state)}`;
        res.redirect(authorizeUrl);
    });
    
    app.get('/api/admin/github/callback', async (req, res) => {
        if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
        try {
            if (!isGitHubOAuthConfigured()) return res.redirect('/admin?github=not-configured');
            if (!req.query.code || !req.query.state || req.query.state !== req.session.githubOAuthState) {
                return res.redirect('/admin?github=state-error');
            }
            const tokenResponse = await axios({
                method: 'post',
                url: 'https://github.com/login/oauth/access_token',
                headers: { Accept: 'application/json', 'User-Agent': 'VIP-CRM-GitHub-Editor' },
                data: {
                    client_id: GITHUB_OAUTH_CONFIG.clientId,
                    client_secret: GITHUB_OAUTH_CONFIG.clientSecret,
                    code: req.query.code,
                    redirect_uri: getGitHubRedirectUri(),
                    state: req.query.state
                }
            });
            if (!tokenResponse.data?.access_token) return res.redirect('/admin?github=token-error');
            const user = await githubApiRequest({ method: 'get', url: 'https://api.github.com/user', token: tokenResponse.data.access_token });
            req.session.githubAuth = {
                accessToken: tokenResponse.data.access_token,
                user: {
                    login: user.login,
                    name: user.name || user.login,
                    avatar_url: user.avatar_url || '',
                    email: user.email || ''
                }
            };
            req.session.githubOAuthState = null;
            addLog(req, `GitHub baglantisi yapildi (${user.login})`);
            res.redirect('/admin?github=connected');
        } catch (e) {
            res.redirect('/admin?github=connect-failed');
        }
    });
    
    app.post('/api/admin/github/logout', (req, res) => {
        if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
        req.session.githubAuth = null;
        req.session.githubOAuthState = null;
        addLog(req, 'GitHub baglantisi kapatildi');
        res.json({ status: 'success' });
    });
    
    app.get('/api/admin/github/repo-tree', async (req, res) => {
        if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
        if (!req.session.githubAuth?.accessToken) return res.status(401).json({ status: 'error', msg: 'GitHub baglantisi yok.' });
        try {
            const tree = await getGitHubRepoTree(req.session.githubAuth.accessToken);
            res.json({ status: 'success', repo: { fullName: tree.fullName, defaultBranch: tree.defaultBranch, private: tree.private }, files: tree.files });
        } catch (e) {
            res.json({ status: 'error', msg: 'Repo dosyalari alinamadi.' });
        }
    });
    
    app.get('/api/admin/github/file', async (req, res) => {
        if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
        if (!req.session.githubAuth?.accessToken) return res.status(401).json({ status: 'error', msg: 'GitHub baglantisi yok.' });
        try {
            const repoPath = String(req.query.path || '').trim();
            if (!repoPath) return res.json({ status: 'error', msg: 'Dosya yolu gerekli.' });
            const file = await getGitHubFile(req.session.githubAuth.accessToken, repoPath);
            res.json({ status: 'success', path: file.path, sha: file.sha, content: file.content, branch: file.defaultBranch, repo: file.fullName });
        } catch (e) {
            res.json({ status: 'error', msg: 'GitHub dosyasi okunamadi.' });
        }
    });
    
    app.post('/api/admin/github/file', async (req, res) => {
        if(!req.session.isAdmin || !hasPerm(req, 'file_manager')) return res.status(403).end();
        if (!req.session.githubAuth?.accessToken) return res.status(401).json({ status: 'error', msg: 'GitHub baglantisi yok.' });
        try {
            const repoPath = String(req.body?.path || '').trim();
            const content = String(req.body?.content || '');
            const sha = String(req.body?.sha || '').trim();
            if (!repoPath) return res.json({ status: 'error', msg: 'Dosya yolu gerekli.' });
            const saveResult = await saveGitHubFile(req.session.githubAuth.accessToken, repoPath, content, sha, req.body?.message, req.session.githubAuth.user || null);
            addLog(req, `GitHub repo dosyasi guncellendi (${repoPath})`);
            res.json({ status: 'success', content: saveResult.content || null, commit: saveResult.commit || null });
        } catch (e) {
            res.json({ status: 'error', msg: 'GitHub dosyasi kaydedilemedi.' });
        }
    });

app.post('/api/admin/login', (req, res) => { db.get(`SELECT * FROM admins WHERE username = ? AND password = ?`, [req.body.username, req.body.password], (err, row) => { if(row) { req.session.isAdmin = true; req.session.adminRole = row.role; req.session.adminPerms = JSON.parse(row.perms || '[]'); req.session.adminUser = row.username; req.session.adminSessionVersion = row.session_version || 0; db.run(`UPDATE admins SET force_logout_message = '', last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [row.id], () => { req.session.save((err) => { addLog(req, "Sisteme Başarıyla Giriş Yaptı"); assignPendingChats(); res.json({ success: true }); }); }); } else { res.status(401).json({ success: false }); } }); });
app.post('/api/admin/logout', (req, res) => { addLog(req, "Sistemden Çıkış Yaptı"); req.session.destroy((err) => { res.json({success: true}); }); });

app.use((err, req, res, next) => { console.error("Yönlendirici Hatası (Engellendi):", err.message); res.status(500).json({ status: "error", msg: "Sunucu tarafında bir işlem reddedildi." }); });

app.get('/robots.txt', async (req, res) => {
    try {
        const settingsMap = await getSettingsMapAsync();
        const baseUrl = getBaseUrl(req, settingsMap);
        res.type('text/plain').send([`User-agent: *`, `Allow: /`, `Sitemap: ${baseUrl}/sitemap.xml`].join('\n'));
    } catch (e) {
        res.type('text/plain').send('User-agent: *\nAllow: /');
    }
});
app.get('/sitemap.xml', async (req, res) => {
    try {
        const settingsMap = await getSettingsMapAsync();
        const baseUrl = getBaseUrl(req, settingsMap);
        const pages = await dbAllAsync(`SELECT slug, seo_noindex FROM pages ORDER BY id ASC`);
        const entries = [
            { loc: `${baseUrl}/`, noindex: Number(settingsMap.index_seo_noindex || 0) === 1 },
            { loc: `${baseUrl}/analizler`, noindex: Number(settingsMap.analizler_seo_noindex || 0) === 1 },
            { loc: `${baseUrl}/forum`, noindex: Number(settingsMap.forum_seo_noindex || 0) === 1 },
            ...pages.map(page => ({ loc: `${baseUrl}/p/${page.slug}`, noindex: Number(page.seo_noindex || 0) === 1 }))
        ].filter(entry => !entry.noindex);
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map(entry => `  <url><loc>${escapeHtml(entry.loc)}</loc></url>`).join('\n')}\n</urlset>`;
        res.type('application/xml').send(xml);
    } catch (e) {
        res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
    }
});
app.get('/', async (req, res) => {
    const settingsMap = await getSettingsMapAsync();
    res.send(renderHtmlWithSeo('index.html', settingsMap, getSystemSeoConfig(req, settingsMap, 'index')));
});
app.get('/index.html', async (req, res) => {
    const settingsMap = await getSettingsMapAsync();
    res.send(renderHtmlWithSeo('index.html', settingsMap, getSystemSeoConfig(req, settingsMap, 'index')));
});
app.get('/analizler', async (req, res) => {
    const settingsMap = await getSettingsMapAsync();
    res.send(renderHtmlWithSeo('analizler.html', settingsMap, getSystemSeoConfig(req, settingsMap, 'analizler')));
});
app.get('/analizler.html', async (req, res) => {
    const settingsMap = await getSettingsMapAsync();
    res.send(renderHtmlWithSeo('analizler.html', settingsMap, getSystemSeoConfig(req, settingsMap, 'analizler')));
});
app.get('/forum', async (req, res) => {
    const settingsMap = await getSettingsMapAsync();
    res.send(renderHtmlWithSeo('forum.html', settingsMap, getSystemSeoConfig(req, settingsMap, 'forum')));
});
app.get('/forum.html', async (req, res) => {
    const settingsMap = await getSettingsMapAsync();
    res.send(renderHtmlWithSeo('forum.html', settingsMap, getSystemSeoConfig(req, settingsMap, 'forum')));
});
app.get('/admin', (req, res) => req.session.isAdmin ? res.sendFile(path.join(__dirname, 'admin.html')) : res.redirect('/admin-login'));
app.get('/admin.html', (req, res) => req.session.isAdmin ? res.sendFile(path.join(__dirname, 'admin.html')) : res.redirect('/admin-login'));
app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login.html', (req, res) => res.redirect('/admin-login'));
app.get('/p/:slug', async (req, res) => {
    const settingsMap = await getSettingsMapAsync();
    const page = await dbGetAsync(`SELECT * FROM pages WHERE slug = ?`, [req.params.slug]);
    res.send(renderHtmlWithSeo('page.html', settingsMap, getDynamicSeoConfig(req, settingsMap, page || { slug: req.params.slug, baslik: 'Sayfa', icerik: '' })));
});
app.get('/page.html', (req, res) => res.redirect('/'));

app.listen(PORT, () => console.log(`🚀 KURUMSAL VIP SİSTEM BAŞLATILDI (PORT: ${PORT})`));