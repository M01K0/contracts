const { expect } = require('chai');
const {
  BN,
  send,
  expectRevert,
  balance,
  ether,
  expectEvent,
  constants,
} = require('@openzeppelin/test-helpers');
const { deployAllProxies } = require('../../deployments');
const {
  getNetworkConfig,
  deployLogicContracts,
} = require('../../deployments/common');
const { initialSettings } = require('../../deployments/settings');
const { deployVRC } = require('../../deployments/vrc');
const {
  removeNetworkFile,
  registerValidator,
  validatorRegistrationArgs,
  getEntityId,
} = require('../common/utils');

const Validators = artifacts.require('Validators');
const Withdrawals = artifacts.require('Withdrawals');
const Operators = artifacts.require('Operators');
const Managers = artifacts.require('Managers');
const Settings = artifacts.require('Settings');
const Pools = artifacts.require('Pools');
const Groups = artifacts.require('Groups');

const validatorDepositAmount = new BN(initialSettings.validatorDepositAmount);
const withdrawalPublicKey =
  '0x940fc4559b53d4566d9693c23ec6b80d7f663fddf9b1c06490cc64602dae1fa6abf2086fdf2b0da703e0e392e0d0528c';
const signature =
  '0xa763fd95e10a3f54e480174a5df246c4dc447605219d13d971ff02dbbbd3fbba8197b65c4738449ad4dec10c14f5f3b51686c3d75bf58eee6e296a6b8254e7073dc4a73b10256bc6d58c8e24d8d462bec6a9f4c224eae703bf6baf5047ed206b';
const publicKey =
  '0xb07ef3635f585b5baeb057a45e7337ab5ba2b1205b43fac3a46e0add8aab242b0fb35a54373ad809405ca05c9cbf34c7';
const depositDataRoot =
  '0x6da4c3b16280ff263d7b32cfcd039c6cf72a3db0d8ef3651370e0aba5277ce2f';

contract('Withdrawals (unlock wallet)', ([_, ...accounts]) => {
  let networkConfig,
    proxies,
    settings,
    validators,
    wallet,
    withdrawals,
    validatorId,
    vrc,
    pools,
    groups;

  let [admin, operator, manager, sender, other] = accounts;

  before(async () => {
    networkConfig = await getNetworkConfig();
    await deployLogicContracts({ networkConfig });
    vrc = await deployVRC({ from: admin });
  });

  after(() => {
    removeNetworkFile(networkConfig.network);
  });

  beforeEach(async () => {
    proxies = await deployAllProxies({
      initialAdmin: admin,
      networkConfig,
      vrc: vrc.options.address,
    });
    let operators = await Operators.at(proxies.operators);
    await operators.addOperator(operator, { from: admin });

    let managers = await Managers.at(proxies.managers);
    await managers.addManager(manager, { from: admin });

    withdrawals = await Withdrawals.at(proxies.withdrawals);
    validators = await Validators.at(proxies.validators);
    settings = await Settings.at(proxies.settings);
    pools = await Pools.at(proxies.pools);
    groups = await Groups.at(proxies.groups);
    validatorId = await registerValidator({
      poolsProxy: proxies.pools,
      operator,
      sender: sender,
      recipient: sender,
    });
    const { logs } = await validators.assignWallet(validatorId, {
      from: manager,
    });
    wallet = logs[0].args.wallet;
  });

  it('user without manager role cannot unlock wallet', async () => {
    await send.ether(sender, wallet, initialSettings.validatorDepositAmount);
    await expectRevert(
      withdrawals.unlockWallet(validatorId, {
        from: operator,
      }),
      'Permission denied.'
    );
  });

  it('user without manager role cannot unlock wallet for private entity', async () => {
    await groups.createPrivateGroup([other], withdrawalPublicKey, {
      from: sender,
    });

    const groupId = getEntityId(groups.address, new BN(1));
    await groups.addDeposit(groupId, other, {
      from: other,
      value: validatorDepositAmount,
    });

    // register validator
    await groups.registerValidator(
      publicKey,
      signature,
      depositDataRoot,
      groupId,
      {
        from: operator,
      }
    );
    let validatorId = web3.utils.soliditySha3(publicKey);

    // assign wallet
    const { logs } = await validators.assignWallet(validatorId, {
      from: manager,
    });
    wallet = logs[0].args.wallet;

    // imitate validator withdrawal
    await send.ether(sender, wallet, validatorDepositAmount.add(ether('1')));

    await expectRevert(
      withdrawals.unlockWallet(validatorId, {
        from: sender,
      }),
      'Permission denied.'
    );
  });

  it('cannot unlock wallet for an invalid validator', async () => {
    await expectRevert(
      withdrawals.unlockWallet(constants.ZERO_BYTES32, {
        from: manager,
      }),
      'Validator must have a wallet assigned.'
    );
  });

  it('cannot unlock wallet with zero balance', async () => {
    await expectRevert(
      withdrawals.unlockWallet(validatorId, {
        from: manager,
      }),
      'Wallet has not enough ether in it.'
    );
  });

  it('cannot unlock wallet twice', async () => {
    await send.ether(sender, wallet, initialSettings.validatorDepositAmount);
    await withdrawals.unlockWallet(validatorId, {
      from: manager,
    });
    await expectRevert(
      withdrawals.unlockWallet(validatorId, {
        from: manager,
      }),
      'Wallet is already unlocked.'
    );
  });

  it("penalty is not applied if balance is not less than validator's deposit", async () => {
    await send.ether(sender, wallet, initialSettings.validatorDepositAmount);
    const { tx } = await withdrawals.unlockWallet(validatorId, {
      from: manager,
    });
    await expectEvent.inTransaction(tx, withdrawals, 'WalletUnlocked', {
      wallet,
    });
    expect(
      await withdrawals.validatorPenalties(validatorId)
    ).to.be.bignumber.equal(new BN(0));
  });

  it('calculates penalties correctly', async () => {
    let tests = [
      // withdrawal return, correct penalty
      [ether('16'), ether('0.5')], // biggest slash possible
      [ether('31.999999999999999999'), ether('0.999999999999999999')], // smallest slash possible
      [ether('31.470154444639959214'), ether('0.983442326394998725')],
      [ether('22.400020050000300803'), ether('0.7000006265625094')],
      [ether('26.037398137005555372'), ether('0.813668691781423605')],
      [ether('18.345'), ether('0.57328125')],
      [ether('16.00145'), ether('0.5000453125')],
      [ether('31.987654321'), ether('0.99961419753125')],
    ];

    for (let i = 0; i < tests.length; i++) {
      await pools.addDeposit(sender, {
        from: sender,
        value: initialSettings.validatorDepositAmount,
      });
      let entityId = getEntityId(pools.address, new BN(i + 2));

      // Collect deposits, create validator
      let validatorId = await registerValidator({
        args: validatorRegistrationArgs[i + 1],
        poolsProxy: pools.address,
        operator,
        entityId,
      });

      // Time for withdrawal, assign wallet
      let receipt = await validators.assignWallet(validatorId, {
        from: manager,
      });
      let wallet = receipt.logs[0].args.wallet;

      const [withdrawalReturn, expectedPenalty] = tests[i];

      // Withdrawal performed, penalized deposit returned
      await send.ether(sender, wallet, withdrawalReturn);

      // Unlock wallet, check whether penalty calculated properly
      receipt = await withdrawals.unlockWallet(validatorId, {
        from: manager,
      });
      await expectEvent.inTransaction(
        receipt.tx,
        withdrawals,
        'WalletUnlocked',
        {
          wallet,
        }
      );
      expect(
        await withdrawals.validatorPenalties(validatorId)
      ).to.be.bignumber.equal(expectedPenalty);
    }
  });

  it('user with manager role can unlock wallet for private entity', async () => {
    await groups.createPrivateGroup([other], withdrawalPublicKey, {
      from: sender,
    });

    const groupId = getEntityId(groups.address, new BN(1));
    await groups.addDeposit(groupId, other, {
      from: other,
      value: validatorDepositAmount,
    });

    // register validator
    await groups.registerValidator(
      publicKey,
      signature,
      depositDataRoot,
      groupId,
      {
        from: operator,
      }
    );
    let validatorId = web3.utils.soliditySha3(publicKey);

    // assign wallet
    const { logs } = await validators.assignWallet(validatorId, {
      from: manager,
    });
    wallet = logs[0].args.wallet;

    // imitate validator withdrawal
    await send.ether(sender, wallet, validatorDepositAmount.add(ether('1')));

    // unlock wallet
    let receipt = await withdrawals.unlockWallet(validatorId, {
      from: manager,
    });
    await expectEvent.inTransaction(receipt.tx, withdrawals, 'WalletUnlocked', {
      wallet,
    });
  });

  it("doesn't send maintainer's reward when no profit", async () => {
    // start tracking maintainer's balance
    const maintainerBalance = await balance.tracker(initialSettings.maintainer);
    await send.ether(sender, wallet, initialSettings.validatorDepositAmount);

    // unlock wallet
    const { tx } = await withdrawals.unlockWallet(validatorId, {
      from: manager,
    });

    await expectEvent.inTransaction(tx, withdrawals, 'WalletUnlocked', {
      wallet,
    });

    // maintainer's balance hasn't changed
    expect(await maintainerBalance.delta()).to.be.bignumber.equal('0');
  });

  it("calculates maintainer's reward correctly", async () => {
    let tests = [
      // validator reward, maintainer's fee, expected maintainer's reward
      ['20884866385064848799', '9561', '19968020750760501936'],
      ['35901110095648257832', '7337', '26340644477177126771'],
      ['13050766221027247901', '9999', '13049461144405145176'],
      ['43915781067913393044', '6465', '28391552460406008602'],
      ['55282543863516569837', '8625', '47681194082283041484'],
      ['25619926040557835738', '4200', '10760368937034291009'],
      ['98340000673116247278', '65', '639210004375255607'],
      ['28044828751583387617', '453', '1270430742446727459'],
      ['57667042368295430137', '8', '46133633894636344'],
      ['31626521340343186340', '9876', '31234352475722930829'],
    ];

    // start tracking maintainer's balance
    const maintainer = initialSettings.maintainer;
    const maintainerBalance = await balance.tracker(maintainer);

    const validatorDepositAmount = new BN(
      initialSettings.validatorDepositAmount
    );

    // run tests
    let receipt;
    for (let i = 0; i < tests.length; i++) {
      const [validatorReward, maintainerFee, expectedMaintainerReward] = tests[
        i
      ];

      // set maintainer's fee
      await settings.setMaintainerFee(maintainerFee, { from: admin });

      await pools.addDeposit(sender, {
        from: sender,
        value: initialSettings.validatorDepositAmount,
      });
      let entityId = getEntityId(pools.address, new BN(i + 2));

      // collect deposits, create validator
      let validatorId = await registerValidator({
        args: validatorRegistrationArgs[i + 1],
        poolsProxy: pools.address,
        operator,
        entityId,
      });

      // time for withdrawal, assign wallet
      receipt = await validators.assignWallet(validatorId, {
        from: manager,
      });
      let wallet = receipt.logs[0].args.wallet;

      // validator receives deposits and rewards from network
      await send.ether(
        sender,
        wallet,
        validatorDepositAmount.add(new BN(validatorReward))
      );

      // unlock wallet
      receipt = await withdrawals.unlockWallet(validatorId, {
        from: manager,
      });
      await expectEvent.inTransaction(
        receipt.tx,
        withdrawals,
        'WalletUnlocked',
        {
          wallet,
        }
      );

      // maintainer's reward calculated properly
      expectEvent(receipt, 'MaintainerWithdrawn', {
        maintainer,
        entityId,
        amount: expectedMaintainerReward,
      });

      // maintainer's balance changed
      expect(await maintainerBalance.delta()).to.be.bignumber.equal(
        new BN(expectedMaintainerReward)
      );

      // wallet's balance changed
      expect(await balance.current(wallet)).to.be.bignumber.equal(
        validatorDepositAmount
          .add(new BN(validatorReward))
          .sub(new BN(expectedMaintainerReward))
      );
    }
  });
});
