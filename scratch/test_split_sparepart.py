def test_split_formulas():
    headers = ["GoodID", "GoodCode", "ราคาสินค้า", "Price Web"]
    rows = [
        [141756, "REF2-00153", 0, 0],
        [6573, "KIT2-SPECIAL", 1000, 800],
        [6894, "HOB2-477016-126", 500, 450]
    ]

    export_id = "1hfHjhC7WdjVDT7qHt19PL8AnxlhTJ6rbbh-N4UBQJBA"
    export_range = "Products Export!A:D"

    no_disc_headers = [headers[0], headers[1], "Price", "Product GID", "Variant GID"]
    with_disc_headers = [headers[0], headers[1], "Compare-at price", headers[3], "Product GID", "Variant GID"]

    no_disc_rows = [no_disc_headers]
    with_disc_rows = [with_disc_headers]

    no_r = 2
    with_r = 2

    for row in rows:
        good_code = str(row[1] or "").strip().upper()
        price_web = float(row[3]) if row[3] else 0.0
        is_kit2 = "KIT2" in good_code

        if price_web == 0 or is_kit2:
            p_f = f'=IFERROR(VLOOKUP(A{no_r}, IMPORTRANGE("{export_id}","{export_range}"), 3, FALSE), "")'
            v_f = f'=IFERROR(VLOOKUP(A{no_r}, IMPORTRANGE("{export_id}","{export_range}"), 4, FALSE), "")'
            no_disc_rows.append([row[0], row[1], row[2], p_f, v_f])
            no_r += 1
        else:
            p_f = f'=IFERROR(VLOOKUP(A{with_r}, IMPORTRANGE("{export_id}","{export_range}"), 3, FALSE), "")'
            v_f = f'=IFERROR(VLOOKUP(A{with_r}, IMPORTRANGE("{export_id}","{export_range}"), 4, FALSE), "")'
            with_disc_rows.append([row[0], row[1], row[2], row[3], p_f, v_f])
            with_r += 1

    print("=== update_no_discount ===")
    for r in no_disc_rows:
        print(r)

    print("\n=== update_with_discount ===")
    for r in with_disc_rows:
        print(r)

if __name__ == "__main__":
    test_split_formulas()
