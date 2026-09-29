"""Add the standalone Reader bridge to an XPI without replacing its existing code.

Usage: python3 scripts/overlay-reader-bridge.py CURRENT.xpi OUTPUT.xpi
Build .scaffold/reader-bridge.js first. The original XPI is never modified.
"""

import argparse
from pathlib import Path
import zipfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error("Source and output must differ; preserve the original XPI.")
    bundle = Path(".scaffold/reader-bridge.js").read_bytes()
    with zipfile.ZipFile(args.source) as original:
        if original.testzip():
            parser.error("The source XPI failed its integrity check.")
        bootstrap = original.read("bootstrap.js").decode()
        if "SidebarReaderBridge" in bootstrap:
            parser.error("This XPI already contains a Reader bridge overlay.")
        startup = "  await Zotero.ZoteroAISidebar.hooks.onStartup();"
        shutdown = "async function shutdown({ id, version, resourceURI, rootURI }, reason) {"
        for anchor in ("var chromeHandle;", startup, shutdown):
            if bootstrap.count(anchor) != 1:
                parser.error(f"Unsupported bootstrap: expected exactly one {anchor!r}")
        bootstrap = bootstrap.replace("var chromeHandle;", "var chromeHandle;\nvar sidebarReaderBridge;")
        bootstrap = bootstrap.replace(startup, startup + """
  // Local Reader MCP overlay; preserve the installed sidebar implementation.
  try {
    const readerCtx = { ...ctx, Zotero, IOUtils };
    Services.scriptloader.loadSubScript(
      `${rootURI}/content/scripts/sidebar-reader-bridge.js`, readerCtx,
    );
    sidebarReaderBridge = readerCtx.SidebarReaderBridge;
    await sidebarReaderBridge.start(Zotero, IOUtils);
  } catch (error) {
    Zotero.logError(error);
  }
""")
        bootstrap = bootstrap.replace(shutdown, shutdown + "\n  sidebarReaderBridge?.stop();\n  sidebarReaderBridge = undefined;")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(args.output, "w", zipfile.ZIP_DEFLATED) as result:
            for entry in original.infolist():
                data = bootstrap.encode() if entry.filename == "bootstrap.js" else original.read(entry.filename)
                result.writestr(entry, data)
            result.writestr("content/scripts/sidebar-reader-bridge.js", bundle)
    with zipfile.ZipFile(args.output) as result:
        if result.testzip():
            raise RuntimeError("The output XPI failed its integrity check.")
    print(args.output)


if __name__ == "__main__":
    main()
