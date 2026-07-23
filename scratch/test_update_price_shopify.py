def simulate_update_price_mutation():
    batch_with_discount = [
        {"id": "gid://shopify/ProductVariant/463122603378", "price": "450.00", "compareAtPrice": "500.00"},
        {"id": "gid://shopify/ProductVariant/463122603379", "price": "800.00", "compareAtPrice": "1000.00"}
    ]

    batch_no_discount = [
        {"id": "gid://shopify/ProductVariant/463122603380", "price": "300.00", "compareAtPrice": None}
    ]

    def build_query(items):
        mutation_lines = []
        for idx, item in enumerate(items):
            if item["compareAtPrice"] is not None:
                compare_part = f', compareAtPrice: "{item["compareAtPrice"]}"'
            else:
                compare_part = ', compareAtPrice: null'
            line = f'v{idx}: productVariantUpdate(input: {{ id: "{item["id"]}", price: "{item["price"]}"{compare_part} }}) {{ productVariant {{ id price compareAtPrice }} userErrors {{ field message }} }}'
            mutation_lines.append(line)
        return "mutation {\n" + "\n".join(mutation_lines) + "\n}"

    print("=== Payload 1: update_with_discount ===")
    print(build_query(batch_with_discount))

    print("\n=== Payload 2: update_no_discount ===")
    print(build_query(batch_no_discount))

if __name__ == "__main__":
    simulate_update_price_mutation()
