const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, ".env") });
require("dotenv").config({ path: path.join(__dirname, "privatekey.env") });

const cors = require("cors");
const express = require("express");
const { ethers } = require("ethers");
const { DatabaseSync } = require("node:sqlite");

const app = express();
const PORT = 3000;
const MAX_TICKETS_PER_WALLET = 5;
const HISTORY_LOOKBACK_BLOCKS = 100000;
const ADMIN_WALLETS = new Set([
	"0x21af91459216f4f63e2fae219adeab27fffa7a73",
	"0x813cfad016a3dea45cd0127e326b94d1a2edda7b",
]);
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const adminNonces = new Map();
const adminSessions = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const RPC_URL = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const CONTRACT_ADDRESS =
	process.env.CONTRACT_ADDRESS || "0xcD49A492f4722642850093BF950BF060F4A896Ea";

if (!ADMIN_PRIVATE_KEY) {
	throw new Error("ADMIN_PRIVATE_KEY is missing from the environment");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const adminWallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);

const contractAbi = [
	"function admitTicket(uint256 tokenId)",
	"function approve(address to, uint256 tokenId)",
	"function buyTicket() payable",
	"function MAX_TICKETS_PER_WALLET() view returns (uint256)",
	"function getApproved(uint256 tokenId) view returns (address)",
	"function balanceOf(address owner) view returns (uint256)",
	"function isApprovedForAll(address owner, address operator) view returns (bool)",
	"function isTicketUsed(uint256) view returns (bool)",
	"function maxTickets() view returns (uint256)",
	"function name() view returns (string)",
	"function owner() view returns (address)",
	"function ownerOf(uint256 tokenId) view returns (address)",
	"function renounceOwnership()",
	"function safeTransferFrom(address from, address to, uint256 tokenId)",
	"function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
	"function setApprovalForAll(address operator, bool approved)",
	"function supportsInterface(bytes4 interfaceId) view returns (bool)",
	"function symbol() view returns (string)",
	"function ticketPrice() view returns (uint256)",
	"function ticketsPurchasedByWallet(address) view returns (uint256)",
	"function tokenURI(uint256 tokenId) view returns (string)",
	"function totalSupply() view returns (uint256)",
	"function transferFrom(address from, address to, uint256 tokenId)",
	"function transferOwnership(address newOwner)",
	"function withdraw()",
	"event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
	"event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
	"event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
	"event TicketAdmitted(uint256 indexed tokenId, uint256 timestamp)",
	"event TicketPurchased(address indexed buyer, uint256 tokenId)",
	"event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const ticketContract = new ethers.Contract(
	CONTRACT_ADDRESS,
	contractAbi,
	adminWallet,
);

const database = new DatabaseSync(
	path.join(__dirname, `ticketing-${CONTRACT_ADDRESS.toLowerCase()}.sqlite`),
);
database.exec(`
	CREATE TABLE IF NOT EXISTS ticket_purchases (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		wallet_address TEXT NOT NULL,
		token_id TEXT NOT NULL UNIQUE,
		transaction_hash TEXT,
		purchased_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_ticket_purchases_wallet
		ON ticket_purchases(wallet_address);
`);

const savePurchase = database.prepare(`
	INSERT OR IGNORE INTO ticket_purchases
		(wallet_address, token_id, transaction_hash, purchased_at)
	VALUES (?, ?, ?, ?)
`);
const getWalletTickets = database.prepare(`
	SELECT token_id AS tokenId, transaction_hash AS transactionHash, purchased_at AS purchasedAt
	FROM ticket_purchases
	WHERE wallet_address = ?
	ORDER BY CAST(token_id AS INTEGER)
`);
const getAllTickets = database.prepare(`
	SELECT wallet_address AS wallet, token_id AS tokenId, transaction_hash AS transactionHash, purchased_at AS purchasedAt
	FROM ticket_purchases
	ORDER BY CAST(token_id AS INTEGER)
`);

function recordPurchase(buyer, tokenId, transactionHash, purchasedAt = new Date().toISOString()) {
	savePurchase.run(
		buyer.toLowerCase(),
		tokenId.toString(),
		transactionHash || null,
		purchasedAt,
	);
}

async function syncPurchaseHistory() {
	try {
		const latestBlock = await provider.getBlockNumber();
		const firstBlock = Math.max(0, latestBlock - HISTORY_LOOKBACK_BLOCKS);
		const events = await ticketContract.queryFilter(
			ticketContract.filters.TicketPurchased(),
			firstBlock,
			latestBlock,
		);
		for (const event of events) {
			recordPurchase(
				event.args[0],
				event.args[1],
				event.transactionHash,
				new Date(Number(event.blockTimestamp || Date.now() / 1000) * 1000).toISOString(),
			);
		}
		console.log(`Ticket database synchronized: ${events.length} purchase event(s).`);
	} catch (error) {
		console.error("Ticket database synchronization failed:", error.shortMessage || error.message);
		try {
			const totalSupply = Number(await ticketContract.totalSupply());
			let recoveredTickets = 0;
			for (let tokenId = 1; tokenId <= totalSupply; tokenId += 1) {
				const owner = await ticketContract.ownerOf(tokenId);
				recordPurchase(owner, tokenId);
				recoveredTickets += 1;
			}
			console.log(`Ticket database recovered ${recoveredTickets} ticket(s) from ownership.`);
		} catch (recoveryError) {
			console.error("Ticket ownership recovery failed:", recoveryError.shortMessage || recoveryError.message);
		}
	}
}

const eventInfo = {
	name: "Blockchain Event Ticketing",
	date: "02-02-2036",
	time: "19:00",
	location: "66B Nguyen Sy Sach Street, Ward 15, Tan Binh District, Ho Chi Minh City, Vietnam",
	description:
		"A live showcase of blockchain technology, featuring NFT tickets and a transparent, Ethereum-powered admission experience.",
	imageUrl: "event-artwork.png",
};

app.get("/api/event-info", (req, res) => {
	res.json(eventInfo);
});

app.get("/api/tickets/:wallet", (req, res) => {
	if (!ethers.isAddress(req.params.wallet)) {
		return res.status(400).json({ error: "Invalid wallet address" });
	}

	const tickets = getWalletTickets.all(req.params.wallet.toLowerCase());
	return res.json({
		wallet: req.params.wallet,
		maxTicketsPerWallet: MAX_TICKETS_PER_WALLET,
		tickets,
		remaining: Math.max(MAX_TICKETS_PER_WALLET - tickets.length, 0),
	});
});

app.get("/api/admin/nonce", (req, res) => {
	const wallet = String(req.query.wallet || "").toLowerCase();
	if (!ethers.isAddress(wallet) || !ADMIN_WALLETS.has(wallet)) {
		return res.status(403).json({ error: "This wallet is not authorized as an admin." });
	}

	const nonce = crypto.randomBytes(24).toString("hex");
	adminNonces.set(wallet, { nonce, expiresAt: Date.now() + 5 * 60 * 1000 });
	return res.json({ nonce });
});

app.post("/api/admin/login", async (req, res) => {
	const { wallet, nonce, signature } = req.body;
	const normalizedWallet = String(wallet || "").toLowerCase();
	const storedNonce = adminNonces.get(normalizedWallet);
	if (!ethers.isAddress(normalizedWallet) || !ADMIN_WALLETS.has(normalizedWallet) || !storedNonce || storedNonce.nonce !== nonce || storedNonce.expiresAt < Date.now()) {
		return res.status(401).json({ error: "Invalid or expired admin login request." });
	}

	try {
		const message = `Admin login for Blockchain Event Ticketing\nWallet: ${normalizedWallet}\nNonce: ${nonce}`;
		const recoveredWallet = ethers.verifyMessage(message, signature).toLowerCase();
		if (recoveredWallet !== normalizedWallet) {
			return res.status(401).json({ error: "Admin wallet signature is invalid." });
		}

		adminNonces.delete(normalizedWallet);
		const token = crypto.randomBytes(32).toString("hex");
		adminSessions.set(token, { wallet: normalizedWallet, expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
		return res.json({ token, wallet: normalizedWallet, expiresIn: ADMIN_SESSION_TTL_MS });
	} catch (error) {
		return res.status(400).json({ error: "Unable to verify admin wallet signature." });
	}
});

function getAdminSession(req) {
	const authorization = req.get("authorization") || "";
	const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
	const session = adminSessions.get(token);
	if (!session || session.expiresAt < Date.now()) {
		if (token) {
			adminSessions.delete(token);
		}
		return null;
	}
	return session;
}

app.get("/api/admin/pending-tickets", async (req, res) => {
	if (!getAdminSession(req)) {
		return res.status(401).json({ error: "Admin login required." });
	}

	try {
		const tickets = await Promise.all(getAllTickets.all().map(async (ticket) => ({
			...ticket,
			admitted: await ticketContract.isTicketUsed(ticket.tokenId),
		})));
		const pendingTickets = tickets.filter((ticket) => !ticket.admitted);
		return res.json({
			pendingCount: pendingTickets.length,
			pendingTickets,
			updatedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.error("Pending ticket lookup failed:", error.shortMessage || error.message);
		return res.status(502).json({ error: "Unable to load pending tickets." });
	}
});

app.post("/api/admit", async (req, res) => {
	if (!getAdminSession(req)) {
		return res.status(401).json({ error: "Admin login required." });
	}

	const { tokenId } = req.body;

	if (
		(typeof tokenId !== "string" && typeof tokenId !== "number") ||
		!/^\d+$/.test(String(tokenId))
	) {
		return res.status(400).json({
			error: "tokenId must be a non-negative integer",
		});
	}

	try {
		const transaction = await ticketContract.admitTicket(tokenId);
		const receipt = await transaction.wait();

		return res.json({
			success: true,
			tokenId: String(tokenId),
			transactionHash: receipt.hash,
		});
	} catch (error) {
		console.error("Ticket admission failed:", error);
		return res.status(500).json({
			success: false,
			error: error.shortMessage || error.message || "Admission failed",
		});
	}
});

ticketContract.on("TicketPurchased", (buyer, tokenId) => {
	recordPurchase(buyer, tokenId, null);
	console.log(
		`TicketPurchased detected: token ${tokenId.toString()} purchased by ${buyer}`,
	);
});

app.listen(PORT, async () => {
	console.log(`Event ticket backend listening on port ${PORT}`);
	console.log(`Admin wallet: ${adminWallet.address}`);
	await syncPurchaseHistory();
});
