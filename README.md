# Committed Cloud Drive Sync Lab

This clean-room system-design practice begins with one question: when several devices upload and edit files while responses,
processes, and connections can fail, how can each device pull a committed namespace history without silent overwrite or a file
entry that points to incomplete bytes?

The title-level prompt is commonly framed as “design Google Drive.” This repository does not copy a product, user interface,
source chapter, or proprietary behavior. The problem contract was frozen before consulting the fixed secondary chapter.

## Current phase

- Closed-book problem contract: [docs/closed-book-contract.md](docs/closed-book-contract.md)
- Fixed-source comparison: pending source review
- Runnable slice and public CI: pending research and implementation

## Evidence boundary

The intended vertical slice may prove immutable byte integrity, optimistic mutation conflict handling, an atomic per-account change
cursor, bounded delta responses, and server-side byte writes. It must not call those facts device receipt, local filesystem apply,
cross-device convergence, screen display, user collaboration, backup safety, or production durability.

## License

MIT. Third-party study material is not included.
