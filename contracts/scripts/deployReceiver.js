const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying Receiver with account: ${deployer.address}`);
  console.log(`Network: ${hre.network.name}`);

  // The relayer wallet address (the one your oracle service signs with when
  // calling deliver() on THIS chain). Same wallet as ORACLE_ADDRESS is fine
  // and expected for this project.
  const relayerAddress = process.env.ORACLE_ADDRESS || deployer.address;

  const Receiver = await hre.ethers.getContractFactory("Receiver");
  const receiver = await Receiver.deploy(relayerAddress);
  await receiver.waitForDeployment();

  const address = await receiver.getAddress();
  console.log(`Receiver deployed to: ${address}`);
  console.log(`Initial relayer set to: ${relayerAddress}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Save this address into oracle/.env as RECEIVER_ADDRESS`);
  console.log(`  2. Make sure the relayer wallet holds gas on THIS chain too (separate from the source chain)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
