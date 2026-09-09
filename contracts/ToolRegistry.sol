// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title ToolRegistry
 * @notice A permissionless marketplace of security tools — Android, desktop,
 * terminal, browser, MCP — published by anyone, hunted with by everyone. The
 * artifact bytes live off chain (Supabase Storage); what lives here is the part
 * that has to be tamper-evident: who published it, the sha256 of the exact bytes
 * they published, where its metadata is, and a $BUG stake they lose if the tool
 * turns out to be malware.
 *
 * Three constraints shape every design decision in this file:
 *
 *  1. Anyone can list, but not for free. Publishing pulls a slashable $BUG stake
 *     (>= minStake). The stake is the publisher's skin in the game: ship malware
 *     and the arbiter slashes it. Permissionless listing with a bond beats a
 *     curated allowlist that centralises who gets to ship a tool.
 *
 *  2. The checksum is the contract. A downloader hashes the bytes they received
 *     and compares to `checksum` recorded here. If it matches, they are running
 *     exactly what the publisher staked on; if it doesn't, the artifact was
 *     tampered with in transit or at rest, regardless of what any mirror says.
 *
 *  3. A malicious publisher must not be able to upload malware, collect
 *     downloads, then withdraw the stake before anyone can slash it. Delisting
 *     starts an `UNSTAKE_DELAY` challenge window, and a flagged tool's stake is
 *     frozen until the arbiter rules. Stake only comes back clean and unhurried.
 *
 * The registry is the source of truth for integrity and attribution; a Supabase
 * mirror indexes the same rows for fast search, filtering and moderation. The
 * mirror can lie or lag — this contract cannot — so clients verify checksum and
 * publisher against chain before trusting a download.
 */
contract ToolRegistry is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @dev Coarse platform tag, kept on chain for tamper-evident filtering.
    /// Index 0 (`Unspecified`) is the zero value, never a real platform.
    enum Platform {
        Unspecified,
        Android,
        Windows,
        MacOS,
        Linux,
        Terminal, // cross-platform CLI
        Browser, // extension / userscript
        MCP, // Model Context Protocol server, for AI agents
        Web, // hosted / web app
        Other
    }

    /// @dev Coarse capability tag. Rich, free-form tags live in the off-chain
    /// metadata; this is only what's worth filtering on chain.
    enum Category {
        Unspecified,
        Recon,
        Scanning,
        Fuzzing,
        Exploitation,
        Forensics,
        Monitoring,
        Reversing,
        Reporting,
        Other
    }

    enum ToolStatus {
        Active, // listed, downloadable, stake at work
        Flagged, // someone raised a flag; stake frozen pending the arbiter
        Slashed, // arbiter ruled it malicious; delisted, stake forfeited
        Delisted // publisher withdrew it; stake released after UNSTAKE_DELAY
    }

    struct Tool {
        address publisher;
        ToolStatus status;
        Platform platform;
        Category category;
        uint64 createdAt;
        uint64 delistedAt; // when Delisted began; gates the unstake window
        uint256 stake; // slashable $BUG backing this listing
        uint256 downloads; // tamper-evident download attestations
        uint32 flagCount; // lifetime flags raised
        uint32 latestVersion; // index into the version array
    }

    struct Version {
        bytes32 checksum; // sha256 of the published artifact bytes
        uint64 publishedAt;
        string metadataURI; // where the tool's metadata JSON is published
        string semver; // publisher-declared version string
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint256 private constant BASIS_POINTS = 10_000;

    /// @dev A voluntarily delisted tool's stake is withdrawable only after this
    /// window, so a rug — publish malware, farm downloads, pull the stake — is
    /// impossible: the challenge window always outlasts the download.
    uint64 public constant UNSTAKE_DELAY = 7 days;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice $BUG. Denominates every publisher stake. The marketplace itself
    /// charges nothing to browse or download.
    IERC20 public immutable bugToken;

    /// @notice Rules on flags: slashes a malicious tool's stake or clears it.
    /// Set once, after deployment.
    address public arbiter;

    /// @notice Where slashed stake accrues (minus any flagger reward).
    address public feeRecipient;

    /// @notice Floor on the stake a new listing must post.
    uint256 public minStake;

    /// @notice Cut of a slashed stake paid to the flagger who was right, in bps.
    /// The rest goes to `feeRecipient`. Rewarding correct flags is how a
    /// permissionless registry crowdsources its own malware review.
    uint256 public flagRewardBps;

    uint256 public nextToolId = 1;

    mapping(uint256 toolId => Tool) private _tools;
    mapping(uint256 toolId => Version[]) private _versions;

    /// @notice The account that raised the still-open flag on a tool. Paid the
    /// flag reward if the arbiter agrees the tool was malicious.
    mapping(uint256 toolId => address) public flaggedBy;

    /// @notice Pull-payment ledger of $BUG owed — slashed proceeds and flag
    /// rewards. Withdrawn with `withdrawCredit`.
    mapping(address account => uint256) public bondCredit;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error NotPublisher();
    error NotArbiter();
    error UnknownTool();
    error NotActive();
    error NotFlagged();
    error AlreadyFlagged();
    error ArbiterAlreadySet();
    error InvalidPlatform();
    error InvalidCategory();
    error InvalidChecksum();
    error MetadataRequired();
    error StakeTooLow(uint256 posted, uint256 required);
    error InvalidBps();
    error NotDelisted();
    error UnstakeWindowOpen(uint64 withdrawableAt);
    error StakeFrozen();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ToolPublished(
        uint256 indexed toolId,
        address indexed publisher,
        Platform platform,
        Category category,
        bytes32 checksum,
        uint256 stake,
        string metadataURI
    );
    event VersionAdded(uint256 indexed toolId, uint32 indexed version, bytes32 checksum, string metadataURI, string semver);
    event StakeIncreased(uint256 indexed toolId, uint256 amount, uint256 stake);
    event ToolDownloaded(uint256 indexed toolId, uint256 downloads);
    event ToolFlagged(uint256 indexed toolId, address indexed flagger, string reasonURI);
    event FlagResolved(uint256 indexed toolId, bool malicious, uint256 slashed, address indexed rewardedFlagger);
    event ToolDelisted(uint256 indexed toolId, uint64 withdrawableAt);
    event StakeWithdrawn(uint256 indexed toolId, address indexed to, uint256 amount);
    event CreditWithdrawn(address indexed account, uint256 amount);

    event ArbiterSet(address indexed arbiter);
    event FeeRecipientSet(address indexed recipient);
    event RegistryTermsSet(uint256 minStake, uint256 flagRewardBps);

    // ---------------------------------------------------------------------
    // Construction and admin
    // ---------------------------------------------------------------------

    constructor(address initialOwner, IERC20 bugToken_, address feeRecipient_, uint256 minStake_)
        Ownable(initialOwner)
    {
        if (address(bugToken_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        bugToken = bugToken_;
        feeRecipient = feeRecipient_;
        minStake = minStake_;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    modifier onlyPublisher(uint256 toolId) {
        if (_tools[toolId].publisher != msg.sender) revert NotPublisher();
        _;
    }

    /// @notice Wires the arbiter once. One-shot so a live registry cannot have
    /// its moderation venue swapped out from under open flags.
    function setArbiter(address arbiter_) external onlyOwner {
        if (arbiter != address(0)) revert ArbiterAlreadySet();
        if (arbiter_ == address(0)) revert ZeroAddress();
        arbiter = arbiter_;
        emit ArbiterSet(arbiter_);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    /// @dev Applies to listings created after this call. Live tools keep the
    /// stake already recorded on them.
    function setRegistryTerms(uint256 minStake_, uint256 flagRewardBps_) external onlyOwner {
        if (flagRewardBps_ > BASIS_POINTS) revert InvalidBps();
        minStake = minStake_;
        flagRewardBps = flagRewardBps_;
        emit RegistryTermsSet(minStake_, flagRewardBps_);
    }

    // ---------------------------------------------------------------------
    // Publishing
    // ---------------------------------------------------------------------

    /**
     * @notice Lists a tool, posting its first version and a slashable $BUG stake.
     * @param platform Coarse platform tag; `Unspecified` is rejected.
     * @param category Coarse capability tag; `Unspecified` is rejected.
     * @param metadataURI Where the tool's metadata JSON is published.
     * @param checksum sha256 of the artifact bytes. The download's integrity
     * proof — non-zero and immutable per version.
     * @param semver Publisher-declared version string.
     * @param stakeAmount $BUG to stake, >= minStake. Pulled from the caller.
     * @dev The caller must have approved `stakeAmount` of $BUG to this contract.
     */
    function publish(
        Platform platform,
        Category category,
        string calldata metadataURI,
        bytes32 checksum,
        string calldata semver,
        uint256 stakeAmount
    ) external nonReentrant returns (uint256 toolId) {
        if (platform == Platform.Unspecified) revert InvalidPlatform();
        if (category == Category.Unspecified) revert InvalidCategory();
        if (checksum == bytes32(0)) revert InvalidChecksum();
        if (bytes(metadataURI).length == 0) revert MetadataRequired();

        uint256 staked = _pullStake(stakeAmount);
        if (staked < minStake) revert StakeTooLow(staked, minStake);

        toolId = nextToolId++;
        Tool storage t = _tools[toolId];
        t.publisher = msg.sender;
        t.status = ToolStatus.Active;
        t.platform = platform;
        t.category = category;
        t.createdAt = uint64(block.timestamp);
        t.stake = staked;

        _versions[toolId].push(
            Version({checksum: checksum, publishedAt: uint64(block.timestamp), metadataURI: metadataURI, semver: semver})
        );

        emit ToolPublished(toolId, msg.sender, platform, category, checksum, staked, metadataURI);
        emit VersionAdded(toolId, 0, checksum, metadataURI, semver);
    }

    /**
     * @notice Publishes a new version of an existing tool. The new checksum and
     * metadata become the latest; prior versions stay readable so a download
     * pinned to an old checksum can still be verified.
     */
    function addVersion(uint256 toolId, string calldata metadataURI, bytes32 checksum, string calldata semver)
        external
        onlyPublisher(toolId)
    {
        Tool storage t = _tools[toolId];
        if (t.status != ToolStatus.Active) revert NotActive();
        if (checksum == bytes32(0)) revert InvalidChecksum();
        if (bytes(metadataURI).length == 0) revert MetadataRequired();

        _versions[toolId].push(
            Version({checksum: checksum, publishedAt: uint64(block.timestamp), metadataURI: metadataURI, semver: semver})
        );
        uint32 version = uint32(_versions[toolId].length - 1);
        t.latestVersion = version;
        emit VersionAdded(toolId, version, checksum, metadataURI, semver);
    }

    /// @notice Tops up a listing's stake. Anyone may back a tool they trust.
    function increaseStake(uint256 toolId, uint256 amount) external nonReentrant {
        Tool storage t = _tools[toolId];
        if (t.publisher == address(0)) revert UnknownTool();
        if (t.status == ToolStatus.Slashed) revert NotActive();
        uint256 added = _pullStake(amount);
        if (added == 0) revert ZeroAmount();
        t.stake += added;
        emit StakeIncreased(toolId, added, t.stake);
    }

    // ---------------------------------------------------------------------
    // Downloads and moderation
    // ---------------------------------------------------------------------

    /**
     * @notice Attests a download on chain. Permissionless and cheap; the mirror
     * keeps the fast counter, this keeps a tamper-evident floor nobody can pad
     * without paying gas. Not payable — the marketplace never charges to hunt.
     */
    function recordDownload(uint256 toolId) external {
        Tool storage t = _tools[toolId];
        if (t.publisher == address(0)) revert UnknownTool();
        unchecked {
            t.downloads += 1;
        }
        emit ToolDownloaded(toolId, t.downloads);
    }

    /**
     * @notice Flags a tool for the arbiter to review — malware, a stolen tool, a
     * lying checksum. Permissionless, one open flag at a time. Flagging freezes
     * the stake and moves the tool out of `Active` so the mirror can hide it
     * while it's under review.
     * @param reasonURI Where the flag's evidence is published.
     */
    function flag(uint256 toolId, string calldata reasonURI) external {
        Tool storage t = _tools[toolId];
        if (t.publisher == address(0)) revert UnknownTool();
        if (t.status == ToolStatus.Slashed) revert NotActive();
        if (t.status == ToolStatus.Flagged) revert AlreadyFlagged();

        t.status = ToolStatus.Flagged;
        t.flagCount += 1;
        flaggedBy[toolId] = msg.sender;
        emit ToolFlagged(toolId, msg.sender, reasonURI);
    }

    /**
     * @notice Arbiter's ruling on an open flag.
     * @param malicious True to slash and delist; false to clear and reinstate.
     * @param slashBps Portion of the stake to slash when malicious, in bps of
     * the current stake. Lets the arbiter scale the penalty to the offence.
     * @dev A correct flagger is paid `flagRewardBps` of the slashed amount; the
     * rest accrues to `feeRecipient`. Clearing a flag restores the tool to
     * `Active` with its stake intact — a bad-faith flag costs the tool nothing.
     */
    function resolveFlag(uint256 toolId, bool malicious, uint256 slashBps)
        external
        nonReentrant
        onlyArbiter
    {
        Tool storage t = _tools[toolId];
        if (t.status != ToolStatus.Flagged) revert NotFlagged();
        if (slashBps > BASIS_POINTS) revert InvalidBps();

        address flagger = flaggedBy[toolId];
        flaggedBy[toolId] = address(0);

        uint256 slashed;
        if (malicious) {
            slashed = (t.stake * slashBps) / BASIS_POINTS;
            if (slashed != 0) {
                t.stake -= slashed;
                uint256 reward = (slashed * flagRewardBps) / BASIS_POINTS;
                if (reward != 0 && flagger != address(0)) bondCredit[flagger] += reward;
                bondCredit[feeRecipient] += slashed - reward;
            }
            t.status = ToolStatus.Slashed; // terminal: delisted, integrity revoked
        } else {
            t.status = ToolStatus.Active; // false alarm; stake untouched
        }

        emit FlagResolved(toolId, malicious, slashed, malicious ? flagger : address(0));
    }

    // ---------------------------------------------------------------------
    // Delisting and stake withdrawal
    // ---------------------------------------------------------------------

    /**
     * @notice Voluntarily delists a tool. Its stake becomes withdrawable only
     * after `UNSTAKE_DELAY`, leaving a window for anyone to flag it first. A
     * flagged tool cannot be delisted out from under the arbiter.
     */
    function delist(uint256 toolId) external onlyPublisher(toolId) {
        Tool storage t = _tools[toolId];
        if (t.status != ToolStatus.Active) revert NotActive();
        t.status = ToolStatus.Delisted;
        t.delistedAt = uint64(block.timestamp);
        uint64 withdrawableAt = t.delistedAt + UNSTAKE_DELAY;
        emit ToolDelisted(toolId, withdrawableAt);
    }

    /**
     * @notice Returns a cleanly delisted tool's stake to its publisher, once the
     * challenge window has passed with no open flag.
     */
    function withdrawStake(uint256 toolId, address to)
        external
        nonReentrant
        onlyPublisher(toolId)
    {
        if (to == address(0)) revert ZeroAddress();
        Tool storage t = _tools[toolId];
        if (t.status != ToolStatus.Delisted) revert NotDelisted();
        uint64 withdrawableAt = t.delistedAt + UNSTAKE_DELAY;
        if (block.timestamp < withdrawableAt) revert UnstakeWindowOpen(withdrawableAt);

        uint256 amount = t.stake;
        if (amount == 0) revert ZeroAmount();
        t.stake = 0;
        bugToken.safeTransfer(to, amount);
        emit StakeWithdrawn(toolId, to, amount);
    }

    /// @notice Withdraws $BUG owed from slashes or flag rewards. Pull payment.
    function withdrawCredit(address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = bondCredit[msg.sender];
        if (amount == 0) revert ZeroAmount();
        bondCredit[msg.sender] = 0;
        bugToken.safeTransfer(to, amount);
        emit CreditWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Pulls $BUG and returns the amount actually received, tolerating
    /// fee-on-transfer tokens by measuring the balance delta.
    function _pullStake(uint256 amount) private returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        uint256 before = bugToken.balanceOf(address(this));
        bugToken.safeTransferFrom(msg.sender, address(this), amount);
        return bugToken.balanceOf(address(this)) - before;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getTool(uint256 toolId) external view returns (Tool memory) {
        Tool memory t = _tools[toolId];
        if (t.publisher == address(0)) revert UnknownTool();
        return t;
    }

    function getVersion(uint256 toolId, uint256 index) external view returns (Version memory) {
        if (_tools[toolId].publisher == address(0)) revert UnknownTool();
        return _versions[toolId][index];
    }

    /// @notice The current (latest) version of a tool.
    function latestVersion(uint256 toolId) external view returns (Version memory) {
        Tool memory t = _tools[toolId];
        if (t.publisher == address(0)) revert UnknownTool();
        return _versions[toolId][t.latestVersion];
    }

    function versionCount(uint256 toolId) external view returns (uint256) {
        if (_tools[toolId].publisher == address(0)) revert UnknownTool();
        return _versions[toolId].length;
    }

    /// @notice Timestamp after which a delisted tool's stake can be withdrawn.
    function unstakeWindow(uint256 toolId) external view returns (uint64) {
        Tool memory t = _tools[toolId];
        if (t.publisher == address(0)) revert UnknownTool();
        return t.delistedAt == 0 ? 0 : t.delistedAt + UNSTAKE_DELAY;
    }
}
