const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying Escrow with account: ${deployer.address}`);
  console.log(`Network: ${hre.network.name}`);

  // The oracle wallet address (the one your oracle service will sign with).
  // Set ORACLE_ADDRESS in your .env, otherwise the deployer is used as the
  // initial oracle (fine for local testing, not for a real demo).
  const oracleAddress = process.env.ORACLE_ADDRESS || deployer.address;

  const Escrow = await hre.ethers.getContractFactory("Escrow");
  const escrow = await Escrow.deploy(oracleAddress);
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  console.log(`Escrow deployed to: ${address}`);
  console.log(`Initial oracle set to: ${oracleAddress}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Save this address into oracle/.env and frontend/.env as ESCROW_ADDRESS_<CHAIN>`);
  console.log(`  2. If oracleAddress differs from a wallet you control, run setOracle() to authorize it`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
