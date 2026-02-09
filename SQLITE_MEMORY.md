# SQLite Memory System

Gitu now uses a high-performance SQLite database for long-term memory.

## Features
-   **Fast**: Uses `better-sqlite3` for synchronous, low-latency access.
-   **Scalable**: Stores unlimited history without JSON parsing overhead.
-   **Searchable**: Includes a `memory` skill to search past conversations.
-   **Migration**: Automatically migrates your existing `memory.json` to `memory.sqlite` on first run.

## Usage

The system works automatically. Your conversations are stored in `memory.sqlite` in the root directory.

### Searching Memory

You can ask the agent to recall information:

```
/goal Recall what we discussed about Project Alpha last week
```

Or via the `memory` skill directly:

```
@assistant Search memory for "Project Alpha"
```

## Schema

The database has a simple schema:

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  timestamp INTEGER NOT NULL
);
```
