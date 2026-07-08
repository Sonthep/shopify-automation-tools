# menu-importer

Shopify menu backup, import, update and export tools.

## 📁 Folder Structure

```
menu-importer/
├── scripts/
│   ├── backup_menu.js       — Backup menu to backups/ (JSON + CSV)
│   ├── fetch_menu.js        — Fetch and print a menu as JSON
│   ├── import_menu.js       — Import menu from data/import_menu.csv
│   ├── merge_and_update.js  — Merge CSV changes and push to Shopify
│   ├── export_menu.py       — Export all menus to Excel (Python)
│   └── test_env_run.js      — Test environment / token check
├── data/
│   ├── import_menu.csv      — Menu CSV for import/update
│   ├── update_cat_sp.csv    — Category update data
│   ├── menu_structure.csv   — Reference menu structure
│   └── test_main.csv        — Test CSV data
├── backups/
│   └── menu-backup-*.json/csv  — Timestamped backups
├── output/
│   ├── menus_export.xlsx        — Full menu export
│   └── menu_categories.xlsx     — Product + Spare Parts sub-cats
└── package.json
```

## 🚀 Quick Start

Run all commands from the **`menu-importer/`** root directory.

### Backup current menu
```powershell
npm run backup
# Saves JSON + CSV to backups/
```

### Export menus to Excel (Python)
```powershell
# All menus → output/menus_export.xlsx
npm run export

# Product + Spare Parts categories only → output/menu_categories.xlsx
npm run export:cat

# Specific menu by handle
py scripts/export_menu.py --handle main-menu
```

### Fetch menu (print JSON)
```powershell
npm run fetch
```

### Import menu from CSV
```powershell
# Dry run (no changes)
npm run import:dry

# Apply changes
npm run import
```

### Merge and update menu
```powershell
npm run merge:dry   # Dry run
npm run merge       # Apply
```

## ⚙️ Environment Variables

All scripts load from **`../../.env`** (the project root `.env`).

| Variable | Description |
|----------|-------------|
| `SHOP_NAME` | e.g. `sevenfive-4062.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN_IMPORT_MENU` | Token for JS scripts (menu read/write) |
| `SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT` | Token for Python export script |
| `MENU_ID` | Default: `gid://shopify/Menu/245262352583` |
