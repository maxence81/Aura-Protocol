pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IOrderBook {
    function store_order(address owner, uint256 asset_hash, bool is_long, uint256 collateral, uint256 leverage, uint256 limit_price) external returns (uint256);
}

contract AuraCrossChainEscrow {
    address public ausd;
    address public orderbook;
    address public keeper;
    address public owner;

    event CrossChainSettlementRequested(uint256 indexed order_id, address indexed owner, uint256 collateral, bool is_long, uint256 leverage, uint256 asset_hash);
    event OrderPlaced(uint256 indexed order_id, address indexed owner);

    function init(address _ausd, address _orderbook, address _keeper) external {
        require(owner == address(0), "Already initialized");
        owner = msg.sender;
        ausd = _ausd;
        orderbook = _orderbook;
        keeper = _keeper;
    }

    function place_limit_order(uint256 asset_hash, bool is_long, uint256 collateral, uint256 leverage, uint256 limit_price) external returns (uint256) {
        require(IERC20(ausd).transferFrom(msg.sender, address(this), collateral), "TransferFrom failed");
        uint256 order_id = IOrderBook(orderbook).store_order(msg.sender, asset_hash, is_long, collateral, leverage, limit_price);
        require(order_id != type(uint256).max, "OrderBook rejected order");
        return order_id;
    }
}
