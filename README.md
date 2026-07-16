
```markdown
# Obsidian S3 Secure Backup

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Obsidian Community](https://img.shields.io/badge/Obsidian-Community%20Plugin-purple.svg)](https://obsidian.md/plugins)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-Critical%20Bugs%20Only-red.svg)](#-maintenance-notice)

`Obsidian-S3-Secure-Backup` is an industrial-grade, bidirectional incremental synchronization and secure backup plugin designed for Obsidian. It seamlessly syncs your Obsidian vault with any S3-compatible cloud storage (e.g., Cloudflare R2, AWS S3, Backblaze B2) and implements a robust dual-track recovery protection mechanism.

---

## 🚨 CRITICAL: Data Safety & Backup Warning

> **Your data is invaluable!**
> Before configuring any sync/backup plugin, **always make a manual local backup of your entire Obsidian vault (compress it as a .zip file and save it somewhere safe).**
> * **Never** debug or test a brand new sync mechanism on an active production vault without a prior backup.
> * While this plugin features strict conflict handling and transaction safeguards, any configuration mistake (e.g., S3 permission errors, out-of-sync system clocks, bucket path mistakes) can lead to unexpected data overwrites.
> * **Highly Recommended**: Set up a small, temporary Test Vault first to familiarize yourself with the sync and recovery flow.

---

## ⚠️ Maintenance Notice

> **Note**
> This project is currently in **Critical-Bugs-Only maintenance** mode.
> * **Not Accepted**: New feature requests, general support, or setup Q&As.
> * **Accepted**: Critical bugs leading to client crashes, data loss, or major security issues.
> * This project is provided "AS-IS". You are welcome to fork and adapt it for your own needs.

---

## ✨ Features

* 🔄 **Bidirectional Incremental Sync**: Intelligently identifies modifications, additions, and deletions across devices. Only transfers changed bytes instead of blind full-force overrides.
* 🚀 **Bootstrap/First-run Automation**: On a clean device installation, the plugin automatically detects empty local index structures and pulls cloud data down to rebuild the indexing database seamlessly.
* 🛑 **Copy-then-Delete Transaction Safeguard**: When performing a deletion locally, the plugin copies the file to a temporary trash folder (`.wastePaper/`) on the remote bucket first. Only upon receiving a successful 200 OK response from the S3 API will the local index and the original file be permanently pruned, avoiding any broken network deletion disasters.
* 🛡️ **Dual-Track Recovery Protection**:
  * **Real-time Trash Bin Explorer (`.wastePaper/`)**: Allows users to recover mistakenly deleted documents directly from the sidebar.
  * **Differential Daily Archives (`.Backup/`)**: Triggers an automated incremental backup of all files modified over the past 24 hours every day on start, maintaining folder hierarchies.
* 📦 **Zero Local-Compute Lifecycle Management**: Offloads physical object cleaning to S3/R2 server-side lifecycle rules to save crucial battery power and resources on mobile/desktop devices.

---

## 🔒 Security and Privacy

* **Vault File Routing**: Vault files are sent only to the HTTPS S3 endpoint configured by the user. There is no telemetry, analytics, or unrelated network traffic.
* **Client-Side Encryption**: This plugin does **not** provide client-side encryption. Please configure encryption-at-rest directly on your storage provider when required.
* **Plain Text Secret Key Warning**: Obsidian stores plugin configurations (including your S3 `secretAccessKey`) as plain text in `.obsidian/plugins/Obsidian-S3-Secure-Backup/data.json`.
* **Least Privilege Principle**: Always use a dedicated, least-privilege S3 credential. Do not reuse account-wide administrator keys. Rotate credentials immediately if your data folder is exposed.
* **Prevent Git Exposure**: Ensure `.obsidian/plugins/*/data.json` is kept out of Git. **Add the following to your root `.gitignore` file immediately**:
  ```text
  .obsidian/plugins/*/data.json

```

* **Clipboard Security**: Copying settings to the clipboard intentionally strips out the `secretAccessKey` to prevent accidental credential leakage.
* **Local Deletion Buffer**: When a remote deletion is synced back to the local device, the plugin routes the file through Obsidian's native trash behavior rather than forcefully performing a physical delete.

---

## ⚙️ Quick Start

### 1. Manual Installation

1. Back up your vault manually before installing.
2. Download `main.js`, `manifest.json`, and `styles.css` from the latest [Release](https://www.google.com/search?q=https://github.com/your-username/obsidian-s3-secure-backup/releases).
3. Create a folder inside your vault: `.obsidian/plugins/obsidian-s3-secure-backup/`.
4. Drop all three files in, and activate the plugin in Obsidian's Community Plugins settings panel.

### 2. S3/R2 Lifecycle Setup Guide (Mandatory)

To leverage the trash and recovery engine without inflating your storage quota indefinitely, **you must configure** the following three lifecycle rules in your object storage console (e.g., Cloudflare R2 / AWS S3):

| Rule Name | Matching Prefix | Action | Expiration (Days) | Purpose |
| --- | --- | --- | --- | --- |
| **Prune Trash** | `.wastePaper/` | Expire Object | 30 Days | Recoverable files buffer zone |
| **Prune Audited Recovery** | `.pickUpPaper/` | Expire Object | 15 Days | Auditing for recovered files |
| **Prune Backups** | `.Backup/` | Expire Object | 7 Days | Incremental daily restore points |

*Note: Object storage platforms typically run lifecycle cleanups asynchronously at around UTC 00:00, introducing a physical deletion delay of up to 24–48 hours.*

---

## 🛠️ Sync Workflow Diagram

```text
               [ Sync Triggered (20s+ Interval) ]
                              │
                ┌─────────────┴─────────────┐
         [ Check Local .Database ]    [ Is files empty / last_sync_time === 0 ]
                │                                       │
                ├─► Yes (Bootstrap Run) ────────────────┼─► 1. ListObjectsV2 (excl. prefixes)
                │                                       │   2. GetObject & Write Locally
                │                                       │   3. Build local .Database
                │
                └─► No (Standard Daily Sync)
                            │
             ┌──────────────┴──────────────┐
      【Phase 1: Pull & Diff】       【Phase 2: Push & Delete】
       - Cloud modified / Local ok:   - Local new / modified:
         GetObject & overwrite.         PutObject + MD5 validation.
       - Cloud modified / Local modified: - Local deleted:
         Rename conflict, then download.Copy-then-Delete chain:
       - Cloud deleted / Local ok:      Copy remote to trash, then
         Delete local via native trash. execute DeleteObject.

```

---

## 💻 Developer Guide

For developers who want to compile, modify, or audit the source code.

### Prerequisite

* NodeJS (v18 or higher is recommended)

### How to Build

1. Clone your repository locally (ideally directly inside a test vault's `.obsidian/plugins/obsidian-s3-secure-backup` folder).
2. Install dependencies:
```bash
npm install

```


3. Start compilation in watch mode (for real-time development):
```bash
npm run dev

```


4. Build the production assets:
```bash
npm run build

```



### Code Quality (ESLint)

This project is configured with custom ESLint rules optimized for Obsidian. Run a check with:

```bash
npm run lint

```

---

## 📄 License

This project is licensed under the **[MIT License](https://www.google.com/search?q=LICENSE)**.

```text
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

```

```