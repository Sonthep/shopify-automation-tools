const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load .env from cwd first
dotenv.config();

// If token not set, try loading parent .env (workspace root)
let token = process.env.SHOPIFY_ACCESS_TOKEN_IMPORT_MENU || process.env.SHOPIFY_ACCESS_TOKEN || '';
if (!token) {
	const parentEnv = path.resolve(__dirname, '..', '.env');
	if (fs.existsSync(parentEnv)) {
		dotenv.config({ path: parentEnv });
		token = process.env.SHOPIFY_ACCESS_TOKEN_IMPORT_MENU || process.env.SHOPIFY_ACCESS_TOKEN || '';
	}
}

const SHOP = process.env.SHOP || process.env.SHOP_NAME || 'sevenfive-4062.myshopify.com';
const TOKEN = token;
const MENU_ID = process.env.MENU_ID || 'gid://shopify/Menu/245262352583';

console.log('SHOP:', SHOP);
console.log('TOKEN:', TOKEN ? (TOKEN.length > 8 ? TOKEN.slice(0, 6) + '...' : TOKEN) : '<empty>');
console.log('MENU_ID:', MENU_ID);
console.log('.env (cwd) exists:', fs.existsSync(path.resolve(process.cwd(), '.env')));
console.log('.env (parent) exists:', fs.existsSync(path.resolve(__dirname, '..', '.env')));
console.log('cwd:', process.cwd());
