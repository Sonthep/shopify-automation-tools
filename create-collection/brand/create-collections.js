// ต้องติดตั้ง: npm install node-fetch@2 csv-parser
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// Load .env if present (optional)
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

// Configuration: prefer environment variables for secrets
// IMPORTANT: Do NOT commit your Admin API token. Set `SHOPIFY_ACCESS_TOKEN` in your environment or a local .env file.
const SHOP_NAME = process.env.SHOP_NAME || 'sevenfive-4062';
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';


// ฟังก์ชันสำหรับหา URL รูปภาพของ vendor (ถ้ามี)
function getVendorImageUrl(vendor) {
  // วิธีที่ 1: ถ้ามี image URL กำหนดไว้ใน vendor object
  if (vendor.image) {
    return vendor.image;
  }

  // วิธีที่ 2: ถ้ามีรูปภาพอยู่ในโฟลเดอร์ local
  const imagePath = path.join(__dirname, 'vendor-images', `${vendor.name}.jpg`);
  if (fs.existsSync(imagePath)) {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    return `data:image/jpeg;base64,${base64Image}`;
  }

  // ถ้าไม่มีรูป return null
  return null;
}

async function createCollectionForVendor(vendor) {
  const imageUrl = getVendorImageUrl(vendor);

  // สร้าง mutation โดยเพิ่ม image field ถ้ามีรูปภาพ
  const imageField = imageUrl ? `image: { src: "${imageUrl}", altText: "${vendor.name} logo" }` : '';

  const mutation = `
    mutation {
      collectionCreate(input: {
        title: "${vendor.name}"
        descriptionHtml: "<p>Shop all products from ${vendor.name} brand.</p>"
        ${imageField}
        ruleSet: {
          appliedDisjunctively: false
          rules: [{
            column: VENDOR
            relation: EQUALS
            condition: "${vendor.name}"
          }]
        }
      }) {
        collection {
          id
          title
          image {
            url
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN
    },
    body: JSON.stringify({ query: mutation })
  });

  const result = await response.json();

  return result;
}

async function createAllCollections(vendors) {
  if (!ACCESS_TOKEN) {
    console.error('ACCESS_TOKEN is empty. Please set a valid Shopify Admin API token.');
    process.exit(1);
  }

  for (const vendor of vendors) {
    console.log(`Creating collection for ${vendor.name}...`);
    try {
      const result = await createCollectionForVendor(vendor);

      if (result.errors) {
        console.error(`✗ API Error for ${vendor.name}:`, JSON.stringify(result.errors));
      } else if (!result.data || !result.data.collectionCreate) {
        console.error(`✗ Unexpected response for ${vendor.name}:`, JSON.stringify(result));
      } else if (result.data.collectionCreate.userErrors.length > 0) {
        console.error(`✗ Error creating ${vendor.name}:`, result.data.collectionCreate.userErrors);
      } else {
        const hasImage = result.data.collectionCreate.collection.image ? '✓ with image' : '✗ no image';
        console.log(`✓ Created: ${vendor.name} ${hasImage}`);
      }
    } catch (err) {
      console.error(`✗ Failed for ${vendor.name}:`, err.message);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\nDone!');
}

function loadVendorsFromCsv(csvPath) {
  return new Promise((resolve, reject) => {
    const vendors = [];
    if (!fs.existsSync(csvPath)) {
      console.warn(`CSV file not found: ${csvPath}`);
      return resolve(vendors);
    }
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (row) => {
        const name  = row['Brand Name'] ? row['Brand Name'].trim() : null;
        const image = row['link image']  ? row['link image'].trim()  : null;
        if (name) vendors.push({ name, image: image || null });
      })
      .on('end', () => resolve(vendors))
      .on('error', reject);
  });
}

async function main() {
  const csvPath = path.join(__dirname, 'image logo.csv');
  const vendors = await loadVendorsFromCsv(csvPath);

  if (vendors.length === 0) {
    console.error('No vendors loaded from CSV. Exiting.');
    process.exit(1);
  }

  const withImage = vendors.filter(v => v.image).length;
  console.log(`Loaded ${vendors.length} vendor(s) from CSV (${withImage} with image).`);

  await createAllCollections(vendors);
}

main().catch(err => console.error('Fatal error:', err.message));
