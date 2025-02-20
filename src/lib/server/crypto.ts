const ENCRYPTION_KEY_LENGTH = 32; // 256 bits
const NONCE_LENGTH = 12; // 96 bits for GCM mode

export async function generateEncryptionKey(): Promise<CryptoKey> {
	return (await crypto.subtle.generateKey(
		{
			name: "AES-GCM",
			length: 256,
		},
		true,
		["encrypt", "decrypt"],
	)) as CryptoKey;
}

export async function encryptText(
	text: string,
	key: CryptoKey,
): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(text);

	// Generate a random nonce
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));

	const encryptedData = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: nonce,
		},
		key,
		data,
	);

	// Combine nonce and encrypted data
	const combined = new Uint8Array(nonce.length + encryptedData.byteLength);
	combined.set(nonce);
	combined.set(new Uint8Array(encryptedData), nonce.length);

	// Convert to base64 for storage
	return btoa(String.fromCharCode(...combined));
}

export async function decryptText(
	encryptedText: string,
	key: CryptoKey,
): Promise<string> {
	// Convert from base64
	const combined = new Uint8Array(
		atob(encryptedText)
			.split("")
			.map((char) => char.charCodeAt(0)),
	);

	// Extract nonce and encrypted data
	const nonce = combined.slice(0, NONCE_LENGTH);
	const encryptedData = combined.slice(NONCE_LENGTH);

	const decryptedData = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: nonce,
		},
		key,
		encryptedData,
	);

	const decoder = new TextDecoder();
	return decoder.decode(decryptedData);
}

export async function createEncryptionKey(): Promise<string> {
	const encryptionKey = await generateEncryptionKey();
	const exportedKey = await crypto.subtle.exportKey("raw", encryptionKey);
	const encryptionKeyBase64 = btoa(
		String.fromCharCode(...new Uint8Array(exportedKey as ArrayBuffer)),
	);
	return encryptionKeyBase64;
}

export async function decryptApiKey(
	apiKey: string,
	encryptionKeyBase64: string,
) {
	const keyData = Uint8Array.from(atob(encryptionKeyBase64), (c) =>
		c.charCodeAt(0),
	);
	const encryptionKey = await crypto.subtle.importKey(
		"raw",
		keyData,
		"AES-GCM",
		true,
		["encrypt", "decrypt"],
	);

	return await decryptText(apiKey, encryptionKey);
}
