// Generate ready-to-paste backup commands for the user's Zotero data and
// profile directories. The plugin DOES NOT execute these — running rsync
// or restic from inside Zotero would block the UI on multi-GB libraries
// and is exactly what dedicated backup tools already do better. We hand
// the user a command they can paste into a terminal or schedule with cron.
//
// Two flavours offered, by use case:
//   - restic: encrypted, deduplicated, incremental — best for ongoing
//     disaster-recovery backup. WebDAV REST endpoint as the repo target.
//   - tar:    one-shot snapshot to a single .tar.gz. Simpler mental model,
//     no repo to manage, fine for occasional manual backups.
//
// SQLite GOTCHA: zotero.sqlite cannot be safely byte-copied while Zotero
// is running (open write transaction = corrupt copy). The generated
// commands include the `sqlite3 .backup` snapshot step so the copy is
// transactionally consistent regardless of Zotero's state.

export interface BackupPaths {
  dataDir: string;
  profileDir: string;
}

export interface ResticOptions {
  webdavUrl: string;
  username: string;
  remoteFolder: string;
}

export function buildResticCommand(
  paths: BackupPaths,
  webdav: ResticOptions,
): string {
  const repoUrl = joinWebDavRepoUrl(webdav.webdavUrl, webdav.remoteFolder);
  const dataDir = shellQuote(paths.dataDir);
  const profileDir = shellQuote(paths.profileDir);
  const sqliteSrc = shellQuote(joinPath(paths.dataDir, 'zotero.sqlite'));
  const sqliteDst = shellQuote(joinPath('/tmp', 'zotero-snapshot.sqlite'));
  return [
    '# 1) 安装 restic：https://restic.readthedocs.io/en/stable/020_installation.html',
    '# 2) 在坚果云后台生成专门给 restic 的应用密码（和 Zotero 文件同步可以共用）',
    `export RESTIC_REPOSITORY=${shellQuote(`rest:${repoUrl}`)}`,
    `export RESTIC_PASSWORD='你设置的 restic 仓库加密密码（首次 init 时设定）'`,
    `# Basic auth 用户名/密码通过 URL 内嵌或 ~/.netrc 提供：`,
    `# https://${webdav.username}:坚果云应用密码@dav.jianguoyun.com/dav/...`,
    '',
    '# 首次：初始化加密仓库（只跑一次）',
    'restic init',
    '',
    '# 备份：先快照 SQLite 保证一致性，再把数据目录 + profile 一起 push',
    `sqlite3 ${sqliteSrc} ".backup ${sqliteDst}"`,
    `restic backup ${dataDir} ${profileDir} ${sqliteDst} \\`,
    '  --exclude="*/cache/*" \\',
    '  --exclude="*/storage/*/.zotero-*" \\',
    '  --tag zotero-ai-sidebar',
    '',
    '# 列出已有快照 / 恢复时使用：',
    '# restic snapshots',
    '# restic restore <snapshot-id> --target /restore/path',
  ].join('\n');
}

export function buildTarCommand(paths: BackupPaths): string {
  const dataDir = shellQuote(paths.dataDir);
  const profileDir = shellQuote(paths.profileDir);
  const sqliteSrc = shellQuote(joinPath(paths.dataDir, 'zotero.sqlite'));
  const sqliteDst = shellQuote(joinPath('/tmp', 'zotero-snapshot.sqlite'));
  const archiveName = `zotero-backup-$(date +%Y%m%d-%H%M%S).tar.gz`;
  return [
    '# 一次性快照：先用 sqlite3 .backup 拿到一个事务一致的 DB 快照，',
    '# 再把 storage/、profile 和那个 DB 快照打成 tar.gz。',
    '',
    `sqlite3 ${sqliteSrc} ".backup ${sqliteDst}"`,
    '',
    `tar --exclude='*/cache/*' \\`,
    `    --exclude='zotero.sqlite' \\`,
    `    --exclude='zotero.sqlite-*' \\`,
    `    -czf ${shellQuote(archiveName)} \\`,
    `    ${dataDir} \\`,
    `    ${profileDir} \\`,
    `    ${sqliteDst}`,
    '',
    '# 然后用 rclone / 坚果云客户端 / scp 把这个 .tar.gz 推到坚果云或别的云盘：',
    '#   rclone copy *.tar.gz nutstore:backup/zotero/',
  ].join('\n');
}

function joinWebDavRepoUrl(baseUrl: string, folder: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedFolder = folder.replace(/^\/+|\/+$/g, '');
  // restic appends its own path components; we just hand it the repo root
  // (e.g., a separate folder for restic vs. zotero-ai-sidebar/state.json).
  return trimmedFolder
    ? `${trimmedBase}/${trimmedFolder}-restic`
    : `${trimmedBase}/zotero-restic`;
}

function joinPath(parent: string, child: string): string {
  if (!parent) return child;
  if (parent.endsWith('/')) return `${parent}${child}`;
  return `${parent}/${child}`;
}

function shellQuote(value: string): string {
  if (value === '') return "''";
  // POSIX-safe single-quote: the only char that needs escaping is the
  // single quote itself, encoded as `'\''` (close, escaped quote, reopen).
  return `'${value.replace(/'/g, "'\\''")}'`;
}
