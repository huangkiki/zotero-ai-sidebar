import { describe, expect, it } from 'vitest';
import {
  buildResticCommand,
  buildTarCommand,
} from '../../src/sync/backup-commands';

const paths = {
  dataDir: '/home/qwer/Zotero',
  profileDir: '/home/qwer/.zotero/zotero/24q8duho.default',
};

const webdav = {
  webdavUrl: 'https://dav.jianguoyun.com/dav/',
  username: 'me@example.com',
  remoteFolder: 'zotero-ai-sidebar',
};

describe('backup command generators', () => {
  it('emits a restic command using the configured paths and a separate restic repo subfolder', () => {
    const cmd = buildResticCommand(paths, webdav);
    expect(cmd).toContain("'/home/qwer/Zotero'");
    expect(cmd).toContain("'/home/qwer/.zotero/zotero/24q8duho.default'");
    expect(cmd).toContain('zotero-ai-sidebar-restic');
    expect(cmd).toContain('sqlite3');
    expect(cmd).toContain('.backup');
    expect(cmd).toContain('restic init');
    expect(cmd).toContain('restic backup');
  });

  it('falls back to a default restic subfolder when remoteFolder is blank', () => {
    const cmd = buildResticCommand(paths, { ...webdav, remoteFolder: '' });
    expect(cmd).toContain('/zotero-restic');
  });

  it('emits a tar command that snapshots SQLite first and excludes the live DB', () => {
    const cmd = buildTarCommand(paths);
    expect(cmd).toContain("sqlite3 '/home/qwer/Zotero/zotero.sqlite'");
    expect(cmd).toContain("--exclude='zotero.sqlite'");
    expect(cmd).toContain("--exclude='zotero.sqlite-*'");
    expect(cmd).toContain("--exclude='*/cache/*'");
    expect(cmd).toContain("'/home/qwer/Zotero'");
    expect(cmd).toContain("'/home/qwer/.zotero/zotero/24q8duho.default'");
  });

  it('safely shell-quotes paths that contain spaces and single quotes', () => {
    const tricky = {
      dataDir: "/home/qwer/My Zotero",
      profileDir: "/home/qwer/o'malley.profile",
    };
    const cmd = buildTarCommand(tricky);
    expect(cmd).toContain("'/home/qwer/My Zotero'");
    // Single-quote inside a single-quoted string is escaped via the
    // standard '\'' close-escape-reopen idiom.
    expect(cmd).toContain("'/home/qwer/o'\\''malley.profile'");
  });
});
