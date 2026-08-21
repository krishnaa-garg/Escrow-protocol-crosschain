const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Escrow", function () {
  let escrow, owner, oracle, sender, recipient, stranger;
  const DEST_CHAIN_ID = 84532; // Base Sepolia, just used as a label here
  const ONE_ETH = ethers.parseEther("1");
  const TIMEOUT = 5 * 60; // MIN_TIMEOUT

  beforeEach(async function () {
    [owner, oracle, sender, recipient, stranger] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("Escrow");
    escrow = await Escrow.deploy(oracle.address);
    await escrow.waitForDeployment();
  });

  describe("deployment", function () {
    it("sets the initial oracle", async function () {
      expect(await escrow.isOracle(oracle.address)).to.equal(true);
      expect(await escrow.isOracle(stranger.address)).to.equal(false);
    });
  });

  describe("lock -> confirmDelivery -> release", function () {
    it("locks native funds and emits TransferLocked", async function () {
      await expect(
        escrow
          .connect(sender)
          .lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, TIMEOUT, { value: ONE_ETH })
      )
        .to.emit(escrow, "TransferLocked")
        .withArgs(1n, sender.address, recipient.address, ethers.ZeroAddress, ONE_ETH, BigInt(DEST_CHAIN_ID), BigInt(TIMEOUT));

      const t = await escrow.getTransfer(1);
      expect(t.status).to.equal(1); // Locked
      expect(t.amount).to.equal(ONE_ETH);
    });

    it("releases funds to the recipient when the oracle confirms delivery", async function () {
      await escrow
        .connect(sender)
        .lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, TIMEOUT, { value: ONE_ETH });

      const before = await ethers.provider.getBalance(recipient.address);

      await expect(escrow.connect(oracle).confirmDelivery(1))
        .to.emit(escrow, "TransferConfirmed")
        .withArgs(1n, recipient.address, ONE_ETH);

      const after = await ethers.provider.getBalance(recipient.address);
      expect(after - before).to.equal(ONE_ETH);

      const t = await escrow.getTransfer(1);
      expect(t.status).to.equal(2); // Confirmed
    });

    it("rejects confirmDelivery from a non-oracle address", async function () {
      await escrow
        .connect(sender)
        .lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, TIMEOUT, { value: ONE_ETH });

      await expect(escrow.connect(stranger).confirmDelivery(1)).to.be.revertedWith(
        "Escrow: caller is not an oracle"
      );
    });

    it("cannot be confirmed twice", async function () {
      await escrow
        .connect(sender)
        .lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, TIMEOUT, { value: ONE_ETH });
      await escrow.connect(oracle).confirmDelivery(1);

      await expect(escrow.connect(oracle).confirmDelivery(1)).to.be.revertedWith(
        "Escrow: transfer not in Locked state"
      );
    });
  });

  describe("lock -> timeout -> refund", function () {
    it("refuses to refund before the timeout has elapsed", async function () {
      await escrow
        .connect(sender)
        .lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, TIMEOUT, { value: ONE_ETH });

      await expect(escrow.connect(stranger).refundOnTimeout(1)).to.be.revertedWith(
        "Escrow: timeout not yet elapsed"
      );
    });

    it("lets anyone trigger a refund to the sender after the timeout elapses", async function () {
      await escrow
        .connect(sender)
        .lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, TIMEOUT, { value: ONE_ETH });

      await time.increase(TIMEOUT + 1);

      const before = await ethers.provider.getBalance(sender.address);

      await expect(escrow.connect(stranger).refundOnTimeout(1))
        .to.emit(escrow, "TransferRefunded")
        .withArgs(1n, sender.address, ONE_ETH, "timeout-elapsed");

      const after = await ethers.provider.getBalance(sender.address);
      expect(after - before).to.equal(ONE_ETH);

      const t = await escrow.getTransfer(1);
      expect(t.status).to.equal(3); // Refunded
    });
  });

  describe("oracle-reported failure (fast refund path)", function () {
    it("lets the oracle refund immediately without waiting for timeout", async function () {
      await escrow
        .connect(sender)
        .lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, TIMEOUT, { value: ONE_ETH });

      const before = await ethers.provider.getBalance(sender.address);

      await expect(escrow.connect(oracle).reportFailure(1))
        .to.emit(escrow, "TransferRefunded")
        .withArgs(1n, sender.address, ONE_ETH, "oracle-reported-failure");

      const after = await ethers.provider.getBalance(sender.address);
      expect(after - before).to.equal(ONE_ETH);
    });

    it("rejects reportFailure from a non-oracle address", async function () {
      await escrow
        .connect(sender)
        .lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, TIMEOUT, { value: ONE_ETH });

      await expect(escrow.connect(stranger).reportFailure(1)).to.be.revertedWith(
        "Escrow: caller is not an oracle"
      );
    });
  });

  describe("input validation", function () {
    it("rejects a zero recipient", async function () {
      await expect(
        escrow.connect(sender).lock(DEST_CHAIN_ID, ethers.ZeroAddress, ethers.ZeroAddress, ONE_ETH, TIMEOUT, {
          value: ONE_ETH,
        })
      ).to.be.revertedWith("Escrow: recipient is zero address");
    });

    it("rejects a mismatched msg.value for native transfers", async function () {
      await expect(
        escrow
          .connect(sender)
          .lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, TIMEOUT, { value: ethers.parseEther("0.5") })
      ).to.be.revertedWith("Escrow: msg.value must equal amount for native transfers");
    });

    it("rejects a timeout below the minimum", async function () {
      await expect(
        escrow.connect(sender).lock(DEST_CHAIN_ID, recipient.address, ethers.ZeroAddress, ONE_ETH, 1, { value: ONE_ETH })
      ).to.be.revertedWith("Escrow: timeout out of range");
    });
  });

  describe("admin", function () {
    it("lets the owner add/remove oracles", async function () {
      await escrow.connect(owner).setOracle(stranger.address, true);
      expect(await escrow.isOracle(stranger.address)).to.equal(true);

      await escrow.connect(owner).setOracle(stranger.address, false);
      expect(await escrow.isOracle(stranger.address)).to.equal(false);
    });

    it("rejects setOracle from a non-owner", async function () {
      await expect(escrow.connect(stranger).setOracle(stranger.address, true)).to.be.reverted;
    });
  });
});
