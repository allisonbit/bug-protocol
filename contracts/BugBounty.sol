// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title BugBounty
 * @notice Escrowed, crowdsourced vulnerability disclosure. Clients fund a
 * program; hunters commit to findings on chain and deliver the plaintext
 * off-chain; accepted findings pay out of escrow the client cannot reclaim.
 *
 * Three constraints shape every design decision in this file:
 *
 *  1. A vulnerability report must NEVER touch the chain in plaintext. A public
 *     report is a live exploit handed to everyone. Hunters submit
 *     keccak256(reportURI, salt, hunter); the body travels off-chain encrypted
 *     to the program owner. Reveal happens only after remediation.
 *
 *  2. A program cannot go Live without a recorded scope and safe-harbour
 *     document (`scopeHash`) AND enough escrow to pay its top severity. Without
 *     recorded authorisation this contract would be coordinating unauthorised
 *     access to third-party systems; without escrow, hunters work for free.
 *
 *  3. A client must not be able to accept a finding and then refuse to pay.
 *     Acceptance credits an unconditional pull-payment claim out of escrow in
 *     the same transaction. There is no "pay later" step to default on, and
 *     locked funds are excluded from every owner withdrawal path.
 *
 * The hunter's anti-spam bond is slashable only on a `Spam` verdict, never on
 * an honest `Rejected`. Charging for good-faith misses is how a bounty platform
 * loses its hunters.
 */
contract BugBounty is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum ProgramStatus {
        Draft, // created, not accepting submissions
        Live, // accepting submissions
        Paused, // temporarily closed, existing submissions still resolvable
        Closed // permanently closed
    }

    /// @dev Index 0 (`None`) is deliberately unpayable so an uninitialised
    /// severity can never resolve to a reward tier.
    enum Severity {
        None,
        Low,
        Medium,
        High,
        Critical
    }

    enum SubStatus {
        Pending, // awaiting triage
        Accepted, // valid; award credited to the hunter
        Rejected, // not a valid finding; bond returned
        Duplicate, // already reported and paid; bond returned
        Spam, // bad faith; bond slashed
        Escalated, // triage SLA lapsed or verdict disputed
        Resolved // escalation settled by the arbiter
    }

    struct Program {
        address owner;
        address rewardToken; // address(0) == native ETH
        bytes32 scopeHash; // keccak256 of the signed scope + safe-harbour doc
        uint64 triageDeadline; // seconds the owner has to triage
        uint64 disclosureDelay; // seconds after resolution before reveal
        ProgramStatus status;
        uint256 pool; // escrowed rewards
        uint256 locked; // pool funds already credited to hunters
        uint256 bond; // slashable good-faith bond, in bugToken
        string scopeURI; // where the scope document is published
    }

    struct Submission {
        uint96 programId;
        address hunter;
        bytes32 commitHash; // keccak256(reportURI, salt, hunter)
        uint64 submittedAt;
        uint64 triagedAt;
        SubStatus status;
        Severity severity;
        uint256 bond; // hunter's anti-spam bond, in bugToken
        uint256 award;
        uint256 dupeOf; // submission this duplicates, when status == Duplicate
        string reportURI; // populated on reveal, never before
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint256 private constant BASIS_POINTS = 10_000;

    /// @dev Floor on triage time. Anything shorter lets a hunter escalate
    /// before a human could plausibly have read the report.
    uint64 public constant MIN_TRIAGE_DEADLINE = 3 days;
    /// @dev Ceiling. A program cannot park findings indefinitely.
    uint64 public constant MAX_TRIAGE_DEADLINE = 30 days;
    /// @dev Ceiling on how long disclosure can be withheld after resolution.
    uint64 public constant MAX_DISCLOSURE_DELAY = 180 days;
    /// @dev Ceiling on the protocol's cut of each award.
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1_000; // 10%

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice $BUG. Denominates hunter anti-spam bonds and client good-faith
    /// bonds. Rewards are paid in whatever the program escrowed.
    IERC20 public immutable bugToken;

    /// @notice Settles escalations. Set once, after deployment.
    address public arbiter;

    /// @notice Protocol cut of each award, in basis points.
    uint256 public protocolFeeBps;
    address public feeRecipient;

    /// @notice Bond a hunter posts per submission, refunded unless slashed.
    uint256 public submissionBond;
    /// @notice Bond a client must post before a program can go Live.
    uint256 public minProgramBond;

    uint256 public nextProgramId = 1;
    uint256 public nextSubmissionId = 1;

    mapping(uint256 programId => Program) private _programs;
    mapping(uint256 programId => mapping(Severity => uint256)) public payoutOf;
    mapping(uint256 submissionId => Submission) private _submissions;

    /// @notice Pull-payment ledger: reward-token balances owed to hunters.
    mapping(address account => mapping(address token => uint256)) public claimable;
    /// @notice Refundable $BUG bond balances owed to hunters and clients.
    mapping(address account => uint256) public bondCredit;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error NotProgramOwner();
    error NotArbiter();
    error NotHunter();
    error UnknownProgram();
    error UnknownSubmission();
    error ProgramNotLive();
    error ProgramNotClosed();
    error InvalidStatusTransition();
    error InvalidTriageDeadline();
    error InvalidDisclosureDelay();
    error InvalidSeverity();
    error InvalidFee();
    error ScopeRequired();
    error PayoutTiersRequired();
    error UnderfundedPool(uint256 available, uint256 required);
    error BondRequired(uint256 posted, uint256 required);
    error AlreadyTriaged();
    error NotPending();
    error TriageWindowOpen(uint64 deadline);
    error TriageWindowClosed(uint64 deadline);
    error NotEscalated();
    error BadDuplicateReference();
    error CommitMismatch();
    error AlreadyRevealed();
    error DisclosureEmbargoed(uint64 revealableAt);
    error NativeValueUnexpected();
    error NativeTransferFailed();
    error ArbiterAlreadySet();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ProgramCreated(
        uint256 indexed programId, address indexed owner, address rewardToken, bytes32 scopeHash, string scopeURI
    );
    event ProgramFunded(uint256 indexed programId, address indexed funder, uint256 amount, uint256 pool);
    event ProgramBonded(uint256 indexed programId, uint256 amount, uint256 bond);
    event ProgramStatusChanged(uint256 indexed programId, ProgramStatus previous, ProgramStatus current);
    event ProgramScopeUpdated(uint256 indexed programId, bytes32 scopeHash, string scopeURI);
    event PayoutTierSet(uint256 indexed programId, Severity severity, uint256 amount);
    event PoolWithdrawn(uint256 indexed programId, address indexed to, uint256 amount);

    event SubmissionCreated(
        uint256 indexed submissionId, uint256 indexed programId, address indexed hunter, bytes32 commitHash
    );
    event SubmissionAccepted(uint256 indexed submissionId, Severity severity, uint256 award, uint256 protocolFee);
    event SubmissionRejected(uint256 indexed submissionId);
    event SubmissionDuplicate(uint256 indexed submissionId, uint256 indexed dupeOf);
    event SubmissionFlaggedSpam(uint256 indexed submissionId, uint256 bondAtRisk);
    event SubmissionSpam(uint256 indexed submissionId, uint256 slashed);
    event SubmissionEscalated(uint256 indexed submissionId, address indexed by, bool slaLapsed);
    event EscalationResolved(uint256 indexed submissionId, bool valid, Severity severity, uint256 award);
    event ProgramBondSlashed(uint256 indexed programId, uint256 amount, address indexed to);
    event SubmissionRevealed(uint256 indexed submissionId, string reportURI);

    event Claimed(address indexed account, address indexed token, uint256 amount);
    event BondWithdrawn(address indexed account, uint256 amount);

    event ArbiterSet(address indexed arbiter);
    event ProtocolFeeSet(uint256 bps, address recipient);
    event BondTermsSet(uint256 submissionBond, uint256 minProgramBond);

    // ---------------------------------------------------------------------
    // Construction and admin
    // ---------------------------------------------------------------------

    constructor(address initialOwner, IERC20 bugToken_, address feeRecipient_, uint256 protocolFeeBps_)
        Ownable(initialOwner)
    {
        if (address(bugToken_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();
        bugToken = bugToken_;
        feeRecipient = feeRecipient_;
        protocolFeeBps = protocolFeeBps_;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    modifier onlyProgramOwner(uint256 programId) {
        if (_programs[programId].owner != msg.sender) revert NotProgramOwner();
        _;
    }

    /// @notice Wires the arbiter once. One-shot so a live protocol cannot have
    /// its dispute venue swapped out from under open escalations.
    function setArbiter(address arbiter_) external onlyOwner {
        if (arbiter != address(0)) revert ArbiterAlreadySet();
        if (arbiter_ == address(0)) revert ZeroAddress();
        arbiter = arbiter_;
        emit ArbiterSet(arbiter_);
    }

    function setProtocolFee(uint256 bps, address recipient) external onlyOwner {
        if (bps > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();
        if (recipient == address(0)) revert ZeroAddress();
        protocolFeeBps = bps;
        feeRecipient = recipient;
        emit ProtocolFeeSet(bps, recipient);
    }

    /// @dev Applies to submissions and programs created after this call. Live
    /// submissions keep the bond recorded on them.
    function setBondTerms(uint256 submissionBond_, uint256 minProgramBond_) external onlyOwner {
        submissionBond = submissionBond_;
        minProgramBond = minProgramBond_;
        emit BondTermsSet(submissionBond_, minProgramBond_);
    }

    // ---------------------------------------------------------------------
    // Client side: programs
    // ---------------------------------------------------------------------

    /**
     * @notice Creates a program in `Draft`. It cannot accept submissions until
     * `setStatus(Live)`, which enforces scope, payout tiers, escrow and bond.
     * @param rewardToken address(0) for native ETH.
     * @param scopeHash keccak256 of the signed scope + safe-harbour document.
     * @param scopeURI Where that document is published.
     * @param tiers Reward per severity, indexed 1..4 (Low..Critical). Index 0
     * is ignored; `Severity.None` is never payable.
     */
    function createProgram(
        address rewardToken,
        bytes32 scopeHash,
        string calldata scopeURI,
        uint256[5] calldata tiers,
        uint64 triageDeadline,
        uint64 disclosureDelay
    ) external returns (uint256 programId) {
        if (scopeHash == bytes32(0) || bytes(scopeURI).length == 0) revert ScopeRequired();
        if (triageDeadline < MIN_TRIAGE_DEADLINE || triageDeadline > MAX_TRIAGE_DEADLINE) {
            revert InvalidTriageDeadline();
        }
        if (disclosureDelay > MAX_DISCLOSURE_DELAY) revert InvalidDisclosureDelay();

        programId = nextProgramId++;
        Program storage p = _programs[programId];
        p.owner = msg.sender;
        p.rewardToken = rewardToken;
        p.scopeHash = scopeHash;
        p.scopeURI = scopeURI;
        p.triageDeadline = triageDeadline;
        p.disclosureDelay = disclosureDelay;
        p.status = ProgramStatus.Draft;

        for (uint256 i = 1; i < 5; ++i) {
            if (tiers[i] != 0) {
                payoutOf[programId][Severity(i)] = tiers[i];
                emit PayoutTierSet(programId, Severity(i), tiers[i]);
            }
        }

        emit ProgramCreated(programId, msg.sender, rewardToken, scopeHash, scopeURI);
    }

    /// @notice Escrows reward funds. Anyone may top up a program.
    function fundProgram(uint256 programId, uint256 amount) external payable nonReentrant {
        Program storage p = _programs[programId];
        if (p.owner == address(0)) revert UnknownProgram();

        uint256 received = _pullReward(p.rewardToken, amount);
        if (received == 0) revert ZeroAmount();
        p.pool += received;
        emit ProgramFunded(programId, msg.sender, received, p.pool);
    }

    /// @notice Posts or tops up the client's slashable good-faith bond, in $BUG.
    function bondProgram(uint256 programId, uint256 amount) external nonReentrant {
        Program storage p = _programs[programId];
        if (p.owner == address(0)) revert UnknownProgram();
        if (amount == 0) revert ZeroAmount();

        uint256 before = bugToken.balanceOf(address(this));
        bugToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = bugToken.balanceOf(address(this)) - before;

        p.bond += received;
        emit ProgramBonded(programId, received, p.bond);
    }

    /**
     * @notice Moves a program between states.
     * @dev Going `Live` is the authorisation gate: scope recorded, at least one
     * payout tier set, escrow covering the top tier, and the client bond posted.
     * `Closed` is terminal.
     */
    function setStatus(uint256 programId, ProgramStatus next) external onlyProgramOwner(programId) {
        Program storage p = _programs[programId];
        ProgramStatus previous = p.status;
        if (previous == ProgramStatus.Closed || previous == next) revert InvalidStatusTransition();

        if (next == ProgramStatus.Live) {
            if (p.scopeHash == bytes32(0)) revert ScopeRequired();
            uint256 top = _topTier(programId);
            if (top == 0) revert PayoutTiersRequired();
            if (p.pool < top) revert UnderfundedPool(p.pool, top);
            if (p.bond < minProgramBond) revert BondRequired(p.bond, minProgramBond);
        }

        p.status = next;
        emit ProgramStatusChanged(programId, previous, next);
    }

    /// @notice Number of un-triaged submissions per program. Every one of them
    /// is fully escrowed; see `submit`.
    mapping(uint256 programId => uint256) public pendingCount;

    /// @notice Republishes scope. Allowed while Live so a client can widen or
    /// clarify scope; the new hash is what later submissions are judged against.
    function setScope(uint256 programId, bytes32 scopeHash, string calldata scopeURI)
        external
        onlyProgramOwner(programId)
    {
        if (scopeHash == bytes32(0) || bytes(scopeURI).length == 0) revert ScopeRequired();
        Program storage p = _programs[programId];
        p.scopeHash = scopeHash;
        p.scopeURI = scopeURI;
        emit ProgramScopeUpdated(programId, scopeHash, scopeURI);
    }

    /// @dev Raising a tier while submissions are pending would break the escrow
    /// invariant, so tiers are only mutable with nothing outstanding.
    function setPayoutTier(uint256 programId, Severity severity, uint256 amount)
        external
        onlyProgramOwner(programId)
    {
        if (severity == Severity.None) revert InvalidSeverity();
        if (pendingCount[programId] != 0) revert NotPending();
        payoutOf[programId][severity] = amount;
        emit PayoutTierSet(programId, severity, amount);
    }

    /**
     * @notice Withdraws unreserved escrow.
     * @dev Reserved = funds already credited to hunters (`locked`) plus full
     * cover for every pending submission. A Live or Paused program therefore
     * cannot be drained below what its open submissions could cost it.
     */
    function withdrawPool(uint256 programId, address to, uint256 amount)
        external
        nonReentrant
        onlyProgramOwner(programId)
    {
        if (to == address(0)) revert ZeroAddress();
        Program storage p = _programs[programId];
        uint256 reserved = pendingCount[programId] * _topTier(programId);
        uint256 free = p.pool > reserved ? p.pool - reserved : 0;
        if (amount == 0 || amount > free) revert UnderfundedPool(free, amount);

        p.pool -= amount;
        _pushReward(p.rewardToken, to, amount);
        emit PoolWithdrawn(programId, to, amount);
    }

    // ---------------------------------------------------------------------
    // Hunter side: submissions
    // ---------------------------------------------------------------------

    /**
     * @notice Commits to a finding without disclosing it.
     * @param commitHash keccak256(abi.encode(reportURI, salt, msg.sender)).
     * Binding the hunter's address into the commit is what stops a mempool
     * watcher from copying the hash and claiming priority: they cannot produce
     * a commit that opens to their own address without knowing the report.
     *
     * @dev Reverts unless the program can cover this submission on top of every
     * other pending one. Capping concurrency is the deliberate trade: it is the
     * only way to promise that an accepted finding is always payable.
     */
    function submit(uint256 programId, bytes32 commitHash) external nonReentrant returns (uint256 submissionId) {
        Program storage p = _programs[programId];
        if (p.owner == address(0)) revert UnknownProgram();
        if (p.status != ProgramStatus.Live) revert ProgramNotLive();
        if (commitHash == bytes32(0)) revert ZeroAmount();

        uint256 outstanding = pendingCount[programId] + 1;
        uint256 required = outstanding * _topTier(programId);
        if (p.pool < required) revert UnderfundedPool(p.pool, required);

        uint256 bond = submissionBond;
        if (bond != 0) {
            uint256 before = bugToken.balanceOf(address(this));
            bugToken.safeTransferFrom(msg.sender, address(this), bond);
            bond = bugToken.balanceOf(address(this)) - before;
            if (bond < submissionBond) revert BondRequired(bond, submissionBond);
        }

        submissionId = nextSubmissionId++;
        Submission storage s = _submissions[submissionId];
        s.programId = uint96(programId);
        s.hunter = msg.sender;
        s.commitHash = commitHash;
        s.submittedAt = uint64(block.timestamp);
        s.status = SubStatus.Pending;
        s.bond = bond;

        pendingCount[programId] = outstanding;
        emit SubmissionCreated(submissionId, programId, msg.sender, commitHash);
    }

    /**
     * @notice Triages a pending submission. Accepting credits the award out of
     * escrow in this same call. There is no separate payment step for a client
     * to default on.
     * @param verdict One of Accepted, Rejected, Duplicate, Spam.
     * @param severity Required for Accepted; must map to a non-zero tier.
     * @param dupeOf Required for Duplicate. Must be an earlier, already-Accepted
     * submission on the same program, so "duplicate" cannot be used to dismiss
     * a finding that was never actually reported or paid.
     */
    function triage(uint256 submissionId, SubStatus verdict, Severity severity, uint256 dupeOf)
        external
        nonReentrant
    {
        Submission storage s = _submissions[submissionId];
        if (s.hunter == address(0)) revert UnknownSubmission();
        if (s.status != SubStatus.Pending) revert NotPending();

        uint256 programId = s.programId;
        Program storage p = _programs[programId];
        if (p.owner != msg.sender) revert NotProgramOwner();

        uint64 deadline = s.submittedAt + p.triageDeadline;
        if (block.timestamp > deadline) revert TriageWindowClosed(deadline);

        s.triagedAt = uint64(block.timestamp);
        s.status = verdict;
        pendingCount[programId] -= 1;

        if (verdict == SubStatus.Accepted) {
            uint256 award = payoutOf[programId][severity];
            if (severity == Severity.None || award == 0) revert InvalidSeverity();
            s.severity = severity;
            s.award = award;
            uint256 fee = _credit(p, s.hunter, award);
            _refundBond(s);
            emit SubmissionAccepted(submissionId, severity, award, fee);
        } else if (verdict == SubStatus.Rejected) {
            // An honest miss costs the hunter nothing.
            _refundBond(s);
            emit SubmissionRejected(submissionId);
        } else if (verdict == SubStatus.Duplicate) {
            Submission storage prior = _submissions[dupeOf];
            if (
                dupeOf == 0 || dupeOf >= submissionId || prior.programId != s.programId
                    || prior.status != SubStatus.Accepted
            ) revert BadDuplicateReference();
            s.dupeOf = dupeOf;
            _refundBond(s);
            emit SubmissionDuplicate(submissionId, dupeOf);
        } else if (verdict == SubStatus.Spam) {
            // The bond is held, not credited, until the hunter's dispute window
            // closes; see `finalizeSpamSlash`. Crediting here would make a bad
            // Spam call irreversible.
            emit SubmissionFlaggedSpam(submissionId, s.bond);
        } else {
            revert InvalidStatusTransition();
        }
    }

    /// @notice Window in which a hunter may dispute a verdict to the arbiter.
    uint64 public constant DISPUTE_WINDOW = 7 days;

    /**
     * @notice Escalates to the arbiter. Two grounds:
     *  - the triage SLA lapsed with the submission still Pending; or
     *  - the hunter disputes a Rejected / Duplicate / Spam verdict, within
     *    `DISPUTE_WINDOW` of it being recorded.
     * @dev A submission escalated from Pending stays counted in `pendingCount`,
     * so its escrow cover is held until the arbiter rules.
     */
    function escalate(uint256 submissionId) external {
        Submission storage s = _submissions[submissionId];
        if (s.hunter == address(0)) revert UnknownSubmission();
        if (s.hunter != msg.sender) revert NotHunter();

        Program storage p = _programs[s.programId];
        bool slaLapsed;

        if (s.status == SubStatus.Pending) {
            uint64 deadline = s.submittedAt + p.triageDeadline;
            if (block.timestamp <= deadline) revert TriageWindowOpen(deadline);
            slaLapsed = true;
            escalatedFromPending[submissionId] = true;
        } else if (
            s.status == SubStatus.Rejected || s.status == SubStatus.Duplicate || s.status == SubStatus.Spam
        ) {
            if (block.timestamp > s.triagedAt + DISPUTE_WINDOW) revert TriageWindowClosed(s.triagedAt + DISPUTE_WINDOW);
        } else {
            revert NotPending();
        }

        s.status = SubStatus.Escalated;
        emit SubmissionEscalated(submissionId, msg.sender, slaLapsed);
    }

    /// @notice Credits a slashed spam bond to the protocol once the hunter's
    /// dispute window has passed without challenge. Permissionless.
    function finalizeSpamSlash(uint256 submissionId) external {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubStatus.Spam) revert NotPending();
        if (block.timestamp <= s.triagedAt + DISPUTE_WINDOW) revert TriageWindowOpen(s.triagedAt + DISPUTE_WINDOW);
        uint256 slashed = s.bond;
        s.bond = 0;
        if (slashed != 0) bondCredit[feeRecipient] += slashed;
        emit SubmissionSpam(submissionId, slashed);
    }

    /// @notice True when a submission reached `Escalated` straight from Pending,
    /// meaning its escrow cover is still counted in `pendingCount`.
    mapping(uint256 submissionId => bool) public escalatedFromPending;

    /**
     * @notice Arbiter's ruling on an escalation.
     * @param valid Whether the finding is a real, in-scope vulnerability.
     * @param severity Tier to pay when `valid`.
     * @param slashHunterBond Set only for bad-faith submissions. Losing an
     * appeal in good faith must not cost the hunter their bond.
 * @dev When escrow cannot cover a valid award. Because the verdict was
 * disputed after the program's reserve was released. The client's $BUG
     * good-faith bond is forfeited to the hunter, pro rata to the unpaid share
     * of the award. That is a penalty, not a make-whole: the bond and the reward
     * are different assets and this contract prices neither.
     */
    function resolveEscalation(uint256 submissionId, bool valid, Severity severity, bool slashHunterBond)
        external
        nonReentrant
        onlyArbiter
    {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubStatus.Escalated) revert NotEscalated();

        uint256 programId = s.programId;
        Program storage p = _programs[programId];

        if (escalatedFromPending[submissionId]) {
            escalatedFromPending[submissionId] = false;
            pendingCount[programId] -= 1;
        }

        s.status = SubStatus.Resolved;
        s.triagedAt = uint64(block.timestamp);

        uint256 award;
        if (valid) {
            award = payoutOf[programId][severity];
            if (severity == Severity.None || award == 0) revert InvalidSeverity();
            s.severity = severity;
            s.award = award;

            if (p.pool >= award) {
                _credit(p, s.hunter, award);
            } else {
                // The bond is $BUG and the award is the program's reward token.
                // There is no sound exchange rate between them and this contract
                // deliberately has no oracle, so the bond is forfeited in  // proportion to how much of the award went unpaid (a
  // dimensionless ratio) rather than pretending one wei of reward
                // equals one wei of $BUG. A total default forfeits the lot.
                uint256 paid = p.pool;
                if (paid != 0) _credit(p, s.hunter, paid);
                uint256 slashed = (p.bond * (award - paid)) / award;
                if (slashed != 0) {
                    p.bond -= slashed;
                    bondCredit[s.hunter] += slashed;
                    emit ProgramBondSlashed(programId, slashed, s.hunter);
                }
            }
        }

        if (slashHunterBond) {
            uint256 hb = s.bond;
            s.bond = 0;
            if (hb != 0) bondCredit[feeRecipient] += hb;
            emit SubmissionSpam(submissionId, hb);
        } else {
            _refundBond(s);
        }

        emit EscalationResolved(submissionId, valid, severity, award);
    }

    // ---------------------------------------------------------------------
    // Disclosure
    // ---------------------------------------------------------------------

    /**
     * @notice Publishes the report, proving it is the one committed to at
     * submission time. Only the hunter may reveal, and only once the program's
     * `disclosureDelay` has run from triage. The embargo exists so a fix can
     * ship before the finding becomes public.
     * @dev The program owner can waive the embargo with `waiveEmbargo`.
     */
    function reveal(uint256 submissionId, string calldata reportURI, bytes32 salt) external {
        Submission storage s = _submissions[submissionId];
        if (s.hunter == address(0)) revert UnknownSubmission();
        if (s.hunter != msg.sender) revert NotHunter();
        if (bytes(s.reportURI).length != 0) revert AlreadyRevealed();
        if (s.status == SubStatus.Pending) revert NotPending();

        Program storage p = _programs[s.programId];
        uint64 revealableAt = s.triagedAt + p.disclosureDelay;
        if (!embargoWaived[submissionId] && block.timestamp < revealableAt) {
            revert DisclosureEmbargoed(revealableAt);
        }
        if (keccak256(abi.encode(reportURI, salt, msg.sender)) != s.commitHash) revert CommitMismatch();

        s.reportURI = reportURI;
        emit SubmissionRevealed(submissionId, reportURI);
    }

    /// @notice Lets the program owner release the disclosure embargo early,
    /// e.g. once a fix is deployed.
    mapping(uint256 submissionId => bool) public embargoWaived;

    function waiveEmbargo(uint256 submissionId) external {
        Submission storage s = _submissions[submissionId];
        if (s.hunter == address(0)) revert UnknownSubmission();
        if (_programs[s.programId].owner != msg.sender) revert NotProgramOwner();
        embargoWaived[submissionId] = true;
    }

    /// @notice Off-chain helper: the exact preimage layout `reveal` verifies.
    function commitmentFor(string calldata reportURI, bytes32 salt, address hunter)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(reportURI, salt, hunter));
    }

    // ---------------------------------------------------------------------
    // Withdrawals (pull payment)
    // ---------------------------------------------------------------------

    /// @notice Withdraws reward-token winnings. Pull payment, so a hunter whose
    /// address reverts on receive cannot block anyone else's triage.
    function claim(address token, address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = claimable[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        claimable[msg.sender][token] = 0;
        _pushReward(token, to, amount);
        emit Claimed(msg.sender, token, amount);
    }

    /// @notice Withdraws refunded or awarded $BUG bond balances.
    function withdrawBond(address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = bondCredit[msg.sender];
        if (amount == 0) revert ZeroAmount();
        bondCredit[msg.sender] = 0;
        bugToken.safeTransfer(to, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @notice Returns a closed program's remaining client bond to its owner.
    function reclaimProgramBond(uint256 programId, address to)
        external
        nonReentrant
        onlyProgramOwner(programId)
    {
        if (to == address(0)) revert ZeroAddress();
        Program storage p = _programs[programId];
        if (p.status != ProgramStatus.Closed) revert ProgramNotClosed();
        if (pendingCount[programId] != 0) revert NotPending();
        uint256 amount = p.bond;
        if (amount == 0) revert ZeroAmount();
        p.bond = 0;
        bugToken.safeTransfer(to, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Moves `award` out of the program pool into the hunter's pull-payment
    /// claim, net of the protocol fee. `locked` is cumulative paid-out, kept for
    /// reporting only; solvency is enforced against `pool` directly.
    function _credit(Program storage p, address hunter, uint256 award) private returns (uint256 fee) {
        fee = (award * protocolFeeBps) / BASIS_POINTS;
        p.pool -= award;
        p.locked += award;
        claimable[hunter][p.rewardToken] += award - fee;
        if (fee != 0) claimable[feeRecipient][p.rewardToken] += fee;
    }

    function _refundBond(Submission storage s) private {
        uint256 b = s.bond;
        if (b != 0) {
            s.bond = 0;
            bondCredit[s.hunter] += b;
        }
    }

    function _topTier(uint256 programId) private view returns (uint256 top) {
        for (uint256 i = 1; i < 5; ++i) {
            uint256 v = payoutOf[programId][Severity(i)];
            if (v > top) top = v;
        }
    }

    function _pullReward(address token, uint256 amount) private returns (uint256) {
        if (token == address(0)) {
            if (amount != 0 && amount != msg.value) revert ZeroAmount();
            return msg.value;
        }
        if (msg.value != 0) revert NativeValueUnexpected();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        return IERC20(token).balanceOf(address(this)) - before;
    }

    function _pushReward(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getProgram(uint256 programId) external view returns (Program memory) {
        Program memory p = _programs[programId];
        if (p.owner == address(0)) revert UnknownProgram();
        return p;
    }

    function getSubmission(uint256 submissionId) external view returns (Submission memory) {
        Submission memory s = _submissions[submissionId];
        if (s.hunter == address(0)) revert UnknownSubmission();
        return s;
    }

    /// @notice Highest reward this program can owe for a single finding.
    function topTier(uint256 programId) external view returns (uint256) {
        return _topTier(programId);
    }

    /// @notice Escrow not reserved for open submissions: what the owner could
    /// withdraw right now.
    function freePool(uint256 programId) external view returns (uint256) {
        Program storage p = _programs[programId];
        uint256 reserved = pendingCount[programId] * _topTier(programId);
        return p.pool > reserved ? p.pool - reserved : 0;
    }

    /// @notice Timestamp after which a Pending submission can be escalated.
    function triageDeadlineOf(uint256 submissionId) external view returns (uint64) {
        Submission storage s = _submissions[submissionId];
        if (s.hunter == address(0)) revert UnknownSubmission();
        return s.submittedAt + _programs[s.programId].triageDeadline;
    }
}
