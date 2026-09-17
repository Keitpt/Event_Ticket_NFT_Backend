const CONTRACT_ADDRESS = "0xcD49A492f4722642850093BF950BF060F4A896Ea";
const CONTRACT_ABI = [ 
	"function admitTicket(uint256 tokenId)",
	"function buyTicket() payable",
	"function MAX_TICKETS_PER_WALLET() view returns (uint256)",
	"function ticketPrice() view returns (uint256)",
	"function ticketsPurchasedByWallet(address) view returns (uint256)",
	"function totalSupply() view returns (uint256)",
	"function maxTickets() view returns (uint256)",
	"event TicketPurchased(address indexed buyer, uint256 tokenId)",
	"event TicketAdmitted(uint256 indexed tokenId, uint256 timestamp)",
];

const FALLBACK_TICKET_PRICE = "0.01";
const ADMISSION_API_URL = "http://localhost:3000/api/admit";
const SEPOLIA_CHAIN_ID = 11155111n;
const MAX_TICKETS_PER_WALLET = 5;
const HISTORY_LOOKBACK_BLOCKS = 100000;
const ADMIN_LOGIN_API_URL = "/api/admin";
const ADMIN_WALLETS = new Set([
	"0x21af91459216f4f63e2fae219adeab27fffa7a73",
	"0x813cfad016a3dea45cd0127e326b94d1a2edda7b",
]);
const DEFAULT_EVENT_INFO = {
	name: "Blockchain Event Ticketing",
	date: "02-02-2036",
	time: "19:00",
	location: "66B Nguyen Sy Sach Street, Ward 15, Tan Binh District, Ho Chi Minh City, Vietnam",
	description:
		"A live showcase of blockchain technology, featuring NFT tickets and a transparent, Ethereum-powered admission experience.",
	imageUrl: "event-artwork.png",
};

let provider;
let signer;
let contract;
let purchaseListener;
let eventTime = DEFAULT_EVENT_INFO.time;
let walletAccount;
let adminSessionToken;
let adminRefreshTimer;

const connectWalletButton = document.getElementById("connectWalletBtn");
const accessScreen = document.getElementById("accessScreen");
const appShell = document.getElementById("appShell");
const customerAccessButton = document.getElementById("customerAccessBtn");
const adminAccessButton = document.getElementById("adminAccessBtn");
const switchRoleButton = document.getElementById("switchRoleBtn");
const walletAddress = document.getElementById("walletAddress");
const buyTicketButton = document.getElementById("buyTicketBtn");
const myTicketsButton = document.getElementById("myTicketsBtn");
const ticketQuantityInput = document.getElementById("ticketQuantity");
const admitTicketButton = document.getElementById("admitTicketBtn");
const tokenIdInput = document.getElementById("tokenIdInput");
const eventLogs = document.getElementById("eventLogs");
const ticketModal = document.getElementById("ticketModal");
const ticketModalClose = document.getElementById("ticketModalClose");
const pendingTicketsCount = document.getElementById("pendingTicketsCount");
const pendingTicketsList = document.getElementById("pendingTicketsList");

function enterWorkspace(role) {
	accessScreen.hidden = true;
	appShell.hidden = false;
	document.getElementById("customerSection").hidden = role !== "customer";
	document.getElementById("adminSection").hidden = role !== "admin";
	document.querySelector(".intro").hidden = role === "admin";
	connectWalletButton.hidden = role !== "customer";
	walletAddress.hidden = false;
	switchRoleButton.hidden = false;
}

function switchRole() {
	appShell.hidden = true;
	accessScreen.hidden = false;
	contract = undefined;
	signer = undefined;
	walletAccount = undefined;
	adminSessionToken = undefined;
	window.clearInterval(adminRefreshTimer);
	walletAddress.textContent = "Wallet not connected";
	connectWalletButton.textContent = "Connect MetaMask";
}

async function refreshAdminPendingTickets() {
	if (!adminSessionToken) {
		return;
	}

	try {
		const response = await fetch("/api/admin/pending-tickets", {
			headers: { Authorization: `Bearer ${adminSessionToken}` },
		});
		const data = await response.json();
		if (!response.ok) {
			throw new Error(data.error || "Unable to load pending tickets.");
		}

		pendingTicketsCount.textContent = data.pendingCount;
		pendingTicketsCount.classList.toggle("empty", data.pendingCount === 0);
		pendingTicketsList.replaceChildren();
		if (data.pendingTickets.length === 0) {
			const emptyItem = document.createElement("li");
			const emptyMessage = document.createElement("p");
			emptyMessage.className = "pending-empty";
			emptyMessage.textContent = "All purchased tickets have been admitted.";
			emptyItem.append(emptyMessage);
			pendingTicketsList.append(emptyItem);
			return;
		}

		data.pendingTickets.forEach((ticket) => {
			const item = document.createElement("li");
			const button = document.createElement("button");
			button.className = "pending-ticket-button";
			button.type = "button";
			button.innerHTML = `<span class="pending-ticket-seat"></span><span class="pending-ticket-wallet"></span>`;
			button.querySelector(".pending-ticket-seat").textContent = `${formatSeatLabel(ticket.tokenId)} / Token ${ticket.tokenId}`;
			button.querySelector(".pending-ticket-wallet").textContent = truncateAddress(ticket.wallet);
			button.addEventListener("click", () => {
				tokenIdInput.value = ticket.tokenId;
				tokenIdInput.focus();
			});
			item.append(button);
			pendingTicketsList.append(item);
		});
	} catch (error) {
		console.error("Pending ticket refresh failed:", error);
	}
}

function startAdminNotifications() {
	refreshAdminPendingTickets();
	window.clearInterval(adminRefreshTimer);
	adminRefreshTimer = window.setInterval(refreshAdminPendingTickets, 15000);
}

function appendLog(message, type = "info") {
	const emptyLog = document.getElementById("emptyLog");
	if (emptyLog) {
		emptyLog.remove();
	}

	const logItem = document.createElement("li");
	logItem.className = "log-item";
	logItem.dataset.type = type;
	logItem.textContent = message;
	eventLogs.prepend(logItem);
}

function truncateAddress(address) {
	return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function showToast(message, type = "success") {
	const toastContainer = document.getElementById("toastContainer");
	const toast = document.createElement("div");
	toast.className = `toast ${type}`;
	toast.innerHTML = `
		<span class="toast-icon" aria-hidden="true">${type === "error" ? "!" : "✓"}</span>
		<span class="toast-message"></span>
		<button class="toast-close" type="button" aria-label="Close notification">&times;</button>
		<span class="toast-progress" aria-hidden="true"></span>
	`;
	toast.querySelector(".toast-message").textContent = message;

	const closeToast = () => toast.remove();
	toast.querySelector(".toast-close").addEventListener("click", closeToast);
	toastContainer.append(toast);
	window.setTimeout(closeToast, 2000);
}

function formatSeatLabel(tokenId) {
	return `VIP-${String(tokenId).padStart(2, "0")}`;
}

function showTicketModal(tokenIds, status) {
	const ticketIds = Array.isArray(tokenIds) ? tokenIds : [tokenIds];
	document.getElementById("ticketModalStatus").textContent = status;
	document.getElementById("ticketModalTitle").textContent = "Your event ticket";
	const seatsElement = document.getElementById("ticketModalSeats");
	seatsElement.replaceChildren(...ticketIds.map((tokenId) => {
		const seat = document.createElement("span");
		seat.className = "ticket-seat-item";
		seat.textContent = formatSeatLabel(tokenId);
		return seat;
	}));
	document.getElementById("ticketModalEvent").textContent = document.getElementById("eventName").textContent;
	document.getElementById("ticketModalDate").textContent = document.getElementById("eventDate").textContent;
	document.getElementById("ticketModalTime").textContent = eventTime;
	document.getElementById("ticketModalLocation").textContent = document.getElementById("eventLocation").textContent;
	ticketModal.hidden = false;
	ticketModalClose.focus();
}

function hideTicketModal() {
	ticketModal.hidden = true;
}

async function ensureSepoliaNetwork() {
	const network = await provider.getNetwork();
	if (network.chainId === SEPOLIA_CHAIN_ID) {
		return;
	}

	try {
		await provider.send("wallet_switchEthereumChain", [
			{ chainId: "0xaa36a7" },
		]);
	} catch (error) {
		if (error.code === 4902) {
			await provider.send("wallet_addEthereumChain", [
				{
					chainId: "0xaa36a7",
					chainName: "Sepolia",
					nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
					rpcUrls: ["https://rpc.sepolia.org"],
					blockExplorerUrls: ["https://sepolia.etherscan.io"],
				},
			]);
		} else {
			throw error;
		}
	}
}

async function loginAdmin() {
	if (!window.ethereum) {
		showToast("Please install MetaMask to access the admin console.", "error");
		return;
	}

	adminAccessButton.disabled = true;
	try {
		provider = new ethers.BrowserProvider(window.ethereum);
		await provider.send("eth_requestAccounts", []);
		await ensureSepoliaNetwork();
		signer = await provider.getSigner();
		const address = (await signer.getAddress()).toLowerCase();
		if (!ADMIN_WALLETS.has(address)) {
			throw new Error("This wallet is not authorized for admin access.");
		}

		const nonceResponse = await fetch(`${ADMIN_LOGIN_API_URL}/nonce?wallet=${address}`);
		const nonceResult = await nonceResponse.json();
		if (!nonceResponse.ok) {
			throw new Error(nonceResult.error || "Unable to start admin login.");
		}

		const message = `Admin login for Blockchain Event Ticketing\nWallet: ${address}\nNonce: ${nonceResult.nonce}`;
		const signature = await signer.signMessage(message);
		const loginResponse = await fetch(`${ADMIN_LOGIN_API_URL}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ wallet: address, nonce: nonceResult.nonce, signature }),
		});
		const loginResult = await loginResponse.json();
		if (!loginResponse.ok) {
			throw new Error(loginResult.error || "Admin login failed.");
		}

		adminSessionToken = loginResult.token;
		walletAccount = address;
		walletAddress.textContent = truncateAddress(address);
		enterWorkspace("admin");
		startAdminNotifications();
		showToast(`Admin access granted: ${truncateAddress(address)}`);
	} catch (error) {
		console.error("Admin login failed:", error);
		const message = error.code === 4001 ? "Admin login signature was rejected." : error.message || "Admin login failed.";
		showToast(message, "error");
		appendLog(message, "error");
	} finally {
		adminAccessButton.disabled = false;
	}
}

async function connectWallet() {
	if (!window.ethereum) {
		appendLog("MetaMask was not detected in this browser.", "error");
		showToast("Please install MetaMask to connect your wallet.", "error");
		return;
	}

	try {
		provider = new ethers.BrowserProvider(window.ethereum);
		await provider.send("eth_requestAccounts", []);
		await ensureSepoliaNetwork();
		signer = await provider.getSigner();
		const address = await signer.getAddress();

		contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
		await updateTicketProgress();
		walletAddress.textContent = truncateAddress(address);
		walletAccount = address;
		connectWalletButton.textContent = "Wallet Connected";
		showToast(`Wallet connected: ${truncateAddress(address)}`);

		await loadHistoricalAdmissions();
		listenForPurchases();
	} catch (error) {
		console.error("Wallet connection failed:", error);
		const message = error.code === 4001
			? "Please switch MetaMask to the Sepolia network."
			: error.shortMessage || "Unable to connect wallet.";
		appendLog(message, "error");
		showToast(message, "error");
	}
}

async function buyTicket() {
	if (!contract) {
		appendLog("Connect MetaMask before buying a ticket.", "error");
		showToast("Connect MetaMask before buying a ticket.", "error");
		return;
	}

	buyTicketButton.disabled = true;

	try {
		const quantity = Number(ticketQuantityInput.value);
		if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_WALLET) {
			throw new Error(`Choose between 1 and ${MAX_TICKETS_PER_WALLET} tickets.`);
		}
		const walletTicketResponse = await fetch(`/api/tickets/${walletAccount}`);
		if (!walletTicketResponse.ok) {
			throw new Error("Unable to check wallet ticket limit.");
		}
		const walletTicketData = await walletTicketResponse.json();
		if (quantity > walletTicketData.remaining) {
			throw new Error(`This wallet can buy only ${walletTicketData.remaining} more ticket(s).`);
		}

		const totalSupply = await contract.totalSupply();
		const maxTickets = await contract.maxTickets();
		if (BigInt(quantity) > maxTickets - totalSupply) {
			throw new Error(`Only ${maxTickets - totalSupply} tickets are still available.`);
		}

		let ticketPrice;
		try {
			ticketPrice = await contract.ticketPrice();
		} catch {
			ticketPrice = ethers.parseEther(FALLBACK_TICKET_PRICE);
		}

		const purchasedTokenIds = [];
		for (let index = 0; index < quantity; index += 1) {
			const transaction = await contract.buyTicket({ value: ticketPrice });
			appendLog(`Purchase ${index + 1}/${quantity} submitted: ${transaction.hash}`);
			const receipt = await transaction.wait();
			const purchaseEvent = receipt.logs.find((log) => log.fragment?.name === "TicketPurchased");
			const tokenId = purchaseEvent.args[1].toString();
			purchasedTokenIds.push(tokenId);
			appendLog(`Seat ${formatSeatLabel(tokenId)} purchased successfully.`);
		}
		showToast(`${quantity} ticket${quantity === 1 ? "" : "s"} purchased successfully.`);
		await updateTicketProgress();
		showTicketModal(purchasedTokenIds, "Tickets purchased successfully");
	} catch (error) {
		console.error("Ticket purchase failed:", error);
		const message = error.shortMessage || error.message || "Ticket purchase failed.";
		appendLog(message, "error");
		showToast(message, "error");
	} finally {
		buyTicketButton.disabled = false;
	}
}

async function showMyTickets() {
	if (!contract || !walletAccount) {
		appendLog("Connect MetaMask before checking your tickets.", "error");
		showToast("Connect MetaMask before checking your tickets.", "error");
		return;
	}

	myTicketsButton.disabled = true;
	try {
		const response = await fetch(`/api/tickets/${walletAccount}`);
		if (!response.ok) {
			throw new Error("Unable to load your tickets from the database.");
		}
		const data = await response.json();
		const tokenIds = data.tickets.map((ticket) => ticket.tokenId);
		if (tokenIds.length === 0) {
			showToast("No tickets found for this wallet.", "error");
			return;
		}

		showTicketModal(tokenIds, `${tokenIds.length} ticket${tokenIds.length === 1 ? "" : "s"} found`);
	} catch (error) {
		console.error("Ticket lookup failed:", error);
		const message = error.shortMessage || "Unable to load your tickets.";
		appendLog(message, "error");
		showToast(message, "error");
	} finally {
		myTicketsButton.disabled = false;
	}
}

async function admitTicket() {
	const tokenId = tokenIdInput.value.trim();

	if (!/^\d+$/.test(tokenId) || Number(tokenId) < 1) {
		appendLog("Enter a valid token ID.", "error");
		showToast("Enter a valid token ID.", "error");
		return;
	}

	admitTicketButton.disabled = true;

	try {
		const response = await fetch(ADMISSION_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${adminSessionToken}`,
			},
			body: JSON.stringify({ tokenId }),
		});
		const result = await response.json();

		if (!response.ok) {
			throw new Error(result.error || "Ticket admission failed.");
		}

		const seatLabel = formatSeatLabel(tokenId);
		appendLog(`Seat ${seatLabel} admitted successfully.`);
		showToast(`Seat ${seatLabel} admitted successfully.`);
		showTicketModal(tokenId, "Ticket admitted successfully");
		tokenIdInput.value = "";
		await refreshAdminPendingTickets();
		await loadHistoricalAdmissions();
	} catch (error) {
		console.error("Ticket admission failed:", error);
		appendLog(error.message || "Ticket admission failed.", "error");
		showToast(error.message || "Ticket admission failed.", "error");
	} finally {
		admitTicketButton.disabled = false;
	}
}

function listenForPurchases() {
	if (!contract) {
		return;
	}

	if (purchaseListener) {
		contract.off("TicketPurchased", purchaseListener);
	}

	purchaseListener = (buyer, tokenId) => {
		appendLog(`Seat ${formatSeatLabel(tokenId)} purchased by ${truncateAddress(buyer)}.`);
	};

	contract.on("TicketPurchased", purchaseListener);
}

async function loadHistoricalAdmissions() {
	if (!contract) {
		return;
	}

	try {
		const filter = contract.filters.TicketAdmitted();
		const latestBlock = await provider.getBlockNumber();
		const firstBlock = Math.max(0, latestBlock - HISTORY_LOOKBACK_BLOCKS);
		const events = await contract.queryFilter(filter, firstBlock, latestBlock);

		events.forEach((event) => {
			const tokenId = event.args[0].toString();
			const timestamp = new Date(Number(event.args[1]) * 1000);
				appendLog(`Seat ${formatSeatLabel(tokenId)} admitted at ${timestamp.toLocaleString()}.`);
		});
	} catch (error) {
		console.error("Historical event query failed:", error);
	}
}

async function updateTicketProgress() {
	const [totalSupply, maxTickets] = await Promise.all([
		contract.totalSupply(),
		contract.maxTickets(),
	]);
	document.getElementById("ticketProgress").textContent =
		`Tickets Sold: ${totalSupply.toString()} / ${maxTickets.toString()}`;
}

async function loadEventInfo() {
	try {
		const response = await fetch("/api/event-info");
		if (!response.ok) {
			throw new Error("Event info request failed.");
		}

		const event = await response.json();
		document.getElementById("eventName").textContent = event.name || "Untitled event";
		document.getElementById("eventDate").textContent = event.date || "Date to be announced";
		document.getElementById("eventLocation").textContent = event.location || "Location to be announced";
		eventTime = event.time || DEFAULT_EVENT_INFO.time;
		document.getElementById("eventDescription").textContent =
			event.description || "Your blockchain-verified event ticket.";

		const image = document.getElementById("eventImage");
		if (event.imageUrl) {
			image.src = event.imageUrl;
		} else {
			image.removeAttribute("src");
		}
	} catch (error) {
		console.error("Event info loading failed:", error);
		document.getElementById("eventName").textContent = DEFAULT_EVENT_INFO.name;
		document.getElementById("eventDate").textContent = DEFAULT_EVENT_INFO.date;
		document.getElementById("eventLocation").textContent = DEFAULT_EVENT_INFO.location;
		eventTime = DEFAULT_EVENT_INFO.time;
	document.getElementById("eventDescription").textContent = DEFAULT_EVENT_INFO.description;
	document.getElementById("eventImage").src = DEFAULT_EVENT_INFO.imageUrl;
	}
}

connectWalletButton.addEventListener("click", connectWallet);
customerAccessButton.addEventListener("click", () => {
	enterWorkspace("customer");
	connectWallet();
});
adminAccessButton.addEventListener("click", loginAdmin);
switchRoleButton.addEventListener("click", switchRole);
buyTicketButton.addEventListener("click", buyTicket);
myTicketsButton.addEventListener("click", showMyTickets);
admitTicketButton.addEventListener("click", admitTicket);
ticketModalClose.addEventListener("click", hideTicketModal);
ticketModal.addEventListener("click", (event) => {
	if (event.target === ticketModal) {
		hideTicketModal();
	}
});
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && !ticketModal.hidden) {
		hideTicketModal();
	}
});

if (window.ethereum) {
	window.ethereum.on("accountsChanged", () => window.location.reload());
}

loadEventInfo();
