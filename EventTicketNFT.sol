// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract EventTicketNFT is ERC721, Ownable {
	uint256 public constant MAX_TICKETS_PER_WALLET = 5;
	uint256 public immutable ticketPrice;
	uint256 public immutable maxTickets;
	uint256 public totalSupply;

	mapping(uint256 => bool) public isTicketUsed;
	mapping(address => uint256) public ticketsPurchasedByWallet;

	event TicketPurchased(address indexed buyer, uint256 tokenId);
	event TicketAdmitted(uint256 indexed tokenId, uint256 timestamp);

	constructor(uint256 _ticketPrice, uint256 _maxTickets)
		ERC721("Event Ticket", "ETKT")
		Ownable(msg.sender)
	{
		require(_maxTickets > 0, "Max tickets must be greater than zero");

		ticketPrice = _ticketPrice;
		maxTickets = _maxTickets;
	}

	function buyTicket() external payable {
		require(msg.value == ticketPrice, "Incorrect ticket price");
		require(totalSupply < maxTickets, "All tickets have been sold");
		require(
			ticketsPurchasedByWallet[msg.sender] < MAX_TICKETS_PER_WALLET,
			"Wallet ticket limit reached"
		);

		uint256 tokenId = totalSupply + 1;
		totalSupply = tokenId;
		ticketsPurchasedByWallet[msg.sender] += 1;
		_safeMint(msg.sender, tokenId);

		emit TicketPurchased(msg.sender, tokenId);
	}

	function admitTicket(uint256 tokenId) external onlyOwner {
		require(_ownerOf(tokenId) != address(0), "Ticket does not exist");
		require(!isTicketUsed[tokenId], "Ticket has already been admitted");

		isTicketUsed[tokenId] = true;
		emit TicketAdmitted(tokenId, block.timestamp);
	}

	function withdraw() external onlyOwner {
		(bool success, ) = payable(owner()).call{value: address(this).balance}("");
		require(success, "Withdrawal failed");
	}
}
