# Setup Sync Pipeline — agent ↔ syncthing ↔ vault ↔ obsidian

Tutorial untuk nyetel **end-to-end pipeline** dari Hermes agent di server sampai Obsidian di laptop. Rantainya:

```
[Hermes agent]  →  [vault server]  ⇄  [Syncthing]  ⇄  [vault laptop]  →  [Obsidian]
   (writes)         /home/hermes/         (relay)        /home/user/        (reads/edits)
```

Mencakup: SSH topology via jumphost, install + pair Syncthing dua sisi, share folder vault, install Obsidian native di WSL (bukan Windows-side biar gak kena issue UNC/EISDIR), bikin shortcut WSLg dengan flag Wayland biar window size proper.

**Hasil akhir:** `~/vault/` di laptop dan `/home/hermes/vault/` di server berisi file identik, sinkron dalam beberapa detik tiap kali salah satu sisi berubah. Obsidian di laptop visualisasi langsung — agent nulis di server, Obsidian refresh otomatis.

---

## Konteks topologi

```
   laptop (WSL)             jumphost              server hermes
   ──────────              ─────────              ─────────────
   192.168.x.x  ────────► 192.168.20.18 ───────► 192.168.99.22
   (Syncthing                 (perantara,             (Syncthing
    laptop)                    SSH only)               server)
```

Laptop **tidak bisa langsung** ke 99.22, harus lewat 20.18. Setup pakai SSH ProxyJump untuk akses bersih.

**Catatan teknis:** Syncthing sync protocol pakai **public relay** (`relays.syncthing.net:22067`) saat direct P2P gak bisa — kasus topologi-mu klasik untuk relay. Yang perlu tunnel manual cuma akses **webui** untuk pairing (sekali setup, gak terus-terusan).

---

## Pre-requisite

- SSH access ke jumphost (20.18) dan server (99.22) sudah berfungsi
- Server hermes punya outbound internet (untuk reach relay infrastruktur Syncthing)
- WSL2 di laptop pakai distro Ubuntu (atau setara) yang support systemd

Cek outbound dari server:

```bash
ssh hermes
curl -s -o /dev/null -w "%{http_code}\n" https://relays.syncthing.net
# 200 = OK. Bukan 200 = server isolated → harus SSH tunnel port 22000 (lihat troubleshooting di akhir)
```

---

## Step 1 — SSH config untuk akses bersih

Edit `~/.ssh/config` di laptop:

```ssh-config
Host jumphost
    HostName 192.168.20.18
    User <user-jumphost>

Host hermes
    HostName 192.168.99.22
    User hermes
    ProxyJump jumphost
```

Test:

```bash
ssh hermes
# Harus langsung masuk ke server 99.22 tanpa interactive prompt di jumphost
```

Sejak titik ini, semua command "di server" diawali `ssh hermes <command>` atau dijalankan dalam SSH session interactive.

---

## Step 2 — Install Syncthing di laptop (WSL)

```bash
sudo apt update && sudo apt install -y syncthing
```

Cek service unit file yang tersedia:

```bash
systemctl list-unit-files | grep -i syncthing
```

Output biasanya:

```
syncthing-resume.service               enabled         enabled
syncthing@.service                     disabled        enabled
```

`syncthing@.service` adalah **template service** — harus di-enable untuk instance user-mu:

```bash
sudo systemctl enable --now syncthing@$USER.service
sudo systemctl status syncthing@$USER.service
```

Status harus `active (running)`. Kalau gagal start, lihat `journalctl -u syncthing@$USER.service -n 50`.

Verifikasi webui:

```bash
ss -lntp 2>/dev/null | grep 8384
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8384
# 200 = jalan
```

Buka browser Windows: **http://localhost:8384** → UI Syncthing laptop muncul.

---

## Step 3 — Install Syncthing di server hermes

```bash
ssh hermes
sudo apt update && sudo apt install -y syncthing
sudo systemctl enable --now syncthing@$USER.service
sudo systemctl status syncthing@$USER.service
ss -lntp | grep 8384
exit
```

Verifikasi proses & port:

```bash
ssh hermes 'ps aux | grep -E "syncthing( |$)" | grep -v grep'
ssh hermes 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8384'
# 200 = jalan
```

Webui server cuma listen di `127.0.0.1:8384` (gak expose ke jaringan, aman). Untuk akses dari laptop → SSH tunnel di step berikut.

---

## Step 4 — Buka SSH tunnel ke webui server

Di terminal terpisah (biarkan terus hidup selama setup):

```bash
ssh hermes -L 8385:localhost:8384 -N
# -L 8385:localhost:8384 = laptop:8385 → server:8384
# -N = no remote command, cuma forwarding
```

Selama tunnel ini hidup:

- `http://localhost:8384` → UI Syncthing **laptop**
- `http://localhost:8385` → UI Syncthing **server**

Buka dua tab browser di Windows dengan URL ini. Sebut "tab L" dan "tab S".

---

## Step 5 — Pairing dua device

### 5.1. Ambil Device ID server

Di **tab S** (`:8385`):

```
Actions (pojok kanan atas) → Show ID
```

Copy device ID yang panjang (format `XXXXXXX-XXXXXXX-...-XXXXXXX`).

### 5.2. Add server sebagai remote device di laptop

Di **tab L** (`:8384`):

```
Add Remote Device (pojok kanan bawah, atau sidebar)
→ Device ID: paste yang dari step 5.1
→ Device Name: hermes (atau apa aja)
→ Address: dynamic (default)
→ Save
```

### 5.3. Approve di server

Di **tab S**, dalam ~10 detik muncul notifikasi:

```
"New Device — Device <ID> wants to connect"
→ Add Device → Save
```

### 5.4. Verifikasi koneksi

Tunggu 10-30 detik. Di kedua tab, status device-nya harus jadi **"Connected"** (hijau).

Kalau setelah 1 menit masih disconnected:

- Cek "Last seen via": kalau menyebut `relay`, koneksi pakai relay (OK, lambat tapi works)
- Kalau tidak ada koneksi sama sekali → outbound firewall block 22067 atau 22000 → lihat troubleshooting

---

## Step 6 — Share folder vault

Vault sudah ada isinya di server (hasil run cron pertama). Share **dari server → laptop**:

### 6.1. Hapus default folder di kedua tab

Tiap install Syncthing punya default folder bernama `Default Folder` (path `~/Sync/`). Bukan yang kita butuh.

Di kedua tab (L & S):

```
Klik "Default Folder" → Edit → Advanced (atau tombol Remove) → Confirm
```

### 6.2. Add folder di tab S (server)

Di tab S:

```
Add Folder
→ Folder Label: vault
→ Folder ID: crypto-vault       ← harus sama persis di kedua sisi nanti
→ Folder Path: /home/hermes/vault
→ Sharing tab: centang device "laptop" (atau apapun nama device laptop di server)
→ Save
```

### 6.3. Accept share di tab L (laptop)

Dalam ~10 detik di tab L muncul notifikasi:

```
"New Folder — Device <hermes> wants to share folder 'crypto-vault'"
→ Add → Folder Path: /home/user/vault
       (atau ~/vault — pastikan path kosong atau belum ada)
→ Save
```

### 6.4. Tunggu sync awal

Sync awal bisa 30 detik – beberapa menit tergantung jumlah file. Status folder di kedua sisi harus akhirnya jadi **"Up to Date"** (hijau).

---

## Step 7 — Verifikasi sync

Di laptop (WSL):

```bash
ls /home/user/vault/                            # 5 folder skeleton harus muncul
ls /home/user/vault/03-Areas/concepts/          # mev.md (kalau cron sudah jalan) harus ada
cat /home/user/vault/03-Areas/concepts/mev.md   # baca isi
```

Test live sync:

```bash
# Di laptop
echo "sync test from laptop $(date)" >> /home/user/vault/00-Inbox/_knowledge/sync-test.md

# Beberapa detik kemudian, di server
ssh hermes 'cat /home/hermes/vault/00-Inbox/_knowledge/sync-test.md'
# Harus tampak teks yang sama
```

Cleanup test file:

```bash
rm /home/user/vault/00-Inbox/_knowledge/sync-test.md
```

---

## Step 8 — Install Obsidian native di WSL

**Jangan** install Obsidian Windows lalu nyebrang ke vault WSL via UNC `\\wsl.localhost\...` — bakal kena error `EISDIR illegal operation on a directory` atau weirdness lain (Obsidian Windows gak akur dengan filesystem WSL). **Install Obsidian Linux di WSL langsung** — vault dibaca native, no boundary crossing.

### 8.1. Install via `.deb`

Download `.deb` terbaru dari [obsidian.md/download](https://obsidian.md/download) (pilih "Linux DEB"), drop ke home WSL, lalu:

```bash
cd ~
sudo apt-get install -y ./obsidian_*.deb
```

Package installer auto-handle dependencies (libnotify4, libsecret-1-0, libxss1, dll) dan bikin binary di `/opt/Obsidian/obsidian` + symlink `/usr/bin/obsidian`.

### 8.2. First launch + open vault

```bash
obsidian &
```

Window muncul via WSLg. Di dialog:

```
Open folder as vault → ketik path: /home/user/vault → Open
```

Pertama buka, Obsidian bikin folder `.obsidian/` di vault (config-nya). Setelah itu vault terbuka — sidebar tampak folder skeleton + concept notes.

Tambah `.stfolder`, `.stversions`, `.stignore` ke **Settings → Files & links → Excluded files** biar marker Syncthing gak muncul di graph view.

### 8.3. Shortcut Windows untuk launch langsung dari Start Menu

Bikin file `.lnk` di Desktop dengan target berikut (catatan: nama distro lu = `Ubuntu-22.04`, ganti kalau beda, cek dengan `wsl -l -v` di PowerShell):

```
"C:\Program Files\WSL\wslg.exe" -d Ubuntu-22.04 --cd "~" -- /opt/Obsidian/obsidian --enable-features=UseOzonePlatform --ozone-platform=wayland
```

Cara bikin (PowerShell):

```powershell
$shortcut = "$env:USERPROFILE\Desktop\Obsidian.lnk"
$wsl = New-Object -ComObject WScript.Shell
$lnk = $wsl.CreateShortcut($shortcut)
$lnk.TargetPath = "C:\Program Files\WSL\wslg.exe"
$lnk.Arguments = '-d Ubuntu-22.04 --cd "~" -- /opt/Obsidian/obsidian --enable-features=UseOzonePlatform --ozone-platform=wayland'
$lnk.Save()
```

**Kenapa flag `--enable-features=UseOzonePlatform --ozone-platform=wayland`:** tanpa flag ini, Obsidian render via X11 di WSLg → window size kacau (kekecilan / kebesaran / blur saat resize). Wayland mode dapat ukuran dan DPI yang benar.

Pin shortcut ke Start Menu / Taskbar setelah ke-create biar one-click launch.

### 8.4. Verifikasi

Setelah vault ke-open:

- Tab daily note: `01-Daily/<hari-ini>.md` muncul kalau cron sudah jalan
- Graph view (`Ctrl+G` atau icon di sidebar kiri) → harus tampak node concept dengan link silang
- Resize window → ukuran responsive, gak ada blur

---

## Troubleshooting

### Relay tidak bisa diakses (curl ke relays.syncthing.net timeout)

Berarti server outbound terbatas. Workaround: SSH tunnel sync port 22000 ke server.

Di laptop, tambah ke SSH command (atau ke `~/.ssh/config` di host `hermes`):

```bash
ssh hermes -L 22001:localhost:22000 -N
```

Di tab L (laptop UI) → klik device hermes → Edit → Addresses: ubah dari `dynamic` ke `tcp://127.0.0.1:22001` → Save. Sync sekarang lewat tunnel.

**Konsekuensi:** tunnel harus tetap hidup. Bikin systemd service atau pakai `autossh` untuk auto-reconnect.

### Service systemctl `--user` gak jalan di WSL

Pakai system-level service dengan sudo (yang sudah ditulis di step 2):

```bash
sudo systemctl enable --now syncthing@$USER.service
```

Kalau masih gagal: jalan langsung tanpa systemd:

```bash
nohup syncthing --no-browser >/dev/null 2>&1 &
```

Tambah ke `~/.bashrc` untuk auto-start saat WSL terbuka:

```bash
pgrep -f "syncthing( |$)" > /dev/null || (nohup syncthing --no-browser >/dev/null 2>&1 &)
```

### File conflict (`.sync-conflict-*.md` muncul)

Berarti file diedit di dua sisi sebelum sync selesai. Solusi:

1. Bandingkan kedua file (yang asli vs `.sync-conflict-*`)
2. Merge manual ke file asli
3. Hapus `.sync-conflict-*`

Pencegahan: jangan edit file yang agent maintain (mis. `patterns.md`) saat jam cron-nya. Atau pisahkan file agent-only dari human-curated.

### Sync lambat / sering stuck

- Cek "Out of Sync Items" di tab masing-masing
- Cek di Folder → klik nama folder → tab Out of Sync — list file yang masalah
- Restart Syncthing: `sudo systemctl restart syncthing@$USER.service`
- Cek log: `journalctl -u syncthing@$USER.service -n 100 --no-pager`

### Lupa device ID atau ganti laptop

Device ID disimpan di `~/.local/state/syncthing/cert.pem` (atau `~/.config/syncthing/cert.pem` versi lama). Kalau hilang, generate baru = device baru = harus pairing ulang.

---

## Maintenance

### Auto-start setelah reboot

`sudo systemctl enable syncthing@$USER.service` sudah di-enable di step 2, jadi setelah reboot service auto-start. Cek dengan:

```bash
systemctl is-enabled syncthing@$USER.service   # harus "enabled"
```

### Backup vault sebelum perubahan besar

Sebelum rombak struktur folder vault:

```bash
# Snapshot tarball
tar -czf ~/vault-backup-$(date +%Y%m%d).tar.gz -C ~ vault/
```

### Pause sync sementara

Saat lu mau bulk edit / reorganize tanpa nge-trigger sync churn:

- Di Folder → klik nama folder → Pause
- Lakukan edits
- Resume saat selesai

### Monitor sync activity

Di tab UI: dashboard utama tampak rate (KB/s), connection state per device, dan list file yang lagi di-sync.

---

*Update tutorial ini kalau ada nuansa baru yang ketemu saat dipakai harian.*
