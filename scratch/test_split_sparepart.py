def test_split_formulas():
    headers = ["GoodID", "GoodCode", "ราคาสินค้า", "Price Web"]
    rows = [
        [141756, "REF2-00153", 0, 0],
        [6573, "KIT2-SPECIAL", 1000, 800],
        [6894, "HOB2-477016-126", 500, 450]
    ]

    gid_map = {
        141756: ("gid://shopify/Product/8643904372935", "gid://shopify/ProductVariant/46276274946247"),
        6573: ("gid://shopify/Product/8644289495239", "gid://shopify/ProductVariant/46277159190727"),
        6894: ("gid://shopify/Product/8643733782727", "gid://shopify/ProductVariant/46276010180807")
    }

    no_disc_headers = [headers[0], headers[1], "Price", "price website", "check price update", "Product GID", "Variant GID"]
    with_disc_headers = [headers[0], headers[1], "Compare At Price", "Price", "Compare At Price Website", "Price Website", "check Compare-at price update", "check price update", "Product GID", "Variant GID"]

    no_disc_rows = [no_disc_headers]
    with_disc_rows = [with_disc_headers]

    no_r = 2
    with_r = 2

    for row in rows:
        good_code = str(row[1] or "").strip().upper()
        price_web = float(row[3]) if row[3] else 0.0
        is_kit2 = "KIT2" in good_code

        p_gid, v_gid = gid_map.get(row[0], ("", ""))

        if price_web == 0 or is_kit2:
            no_disc_rows.append([row[0], row[1], row[2], f"=VLOOKUP(A{no_r},'price website'!A:E,5,false)", f"=C{no_r}=D{no_r}", p_gid, v_gid])
            no_r += 1
        else:
            with_disc_rows.append([row[0], row[1], row[2], row[3], f"=VLOOKUP(A{with_r},'price website'!A:G,6,false)", f"=VLOOKUP(A{with_r},'price website'!A:G,5,false)", f"=C{with_r}=E{with_r}", f"=D{with_r}=F{with_r}", p_gid, v_gid])
            with_r += 1

    print("=== update_no_discount ===")
    for r in no_disc_rows:
        print(r)

    print("\n=== update_with_discount ===")
    for r in with_disc_rows:
        print(r)

if __name__ == "__main__":
    test_split_formulas()
