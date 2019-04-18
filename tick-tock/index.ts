import { PlatformAddress } from "codechain-primitives";
import { SDK } from "codechain-sdk";
import { Asset } from "codechain-sdk/lib/core/Asset";
import { AssetTransferInput } from "codechain-sdk/lib/core/transaction/AssetTransferInput";
import * as config from "config";
import { shuffle } from "underscore";
import { activateApprovers } from "./src/active";
import { approve } from "./src/approve";
import {
    createApprovers,
    loadApprovers,
    storeApprovers
} from "./src/approvers";
import { sendEMail } from "./src/email";
import { mintHands } from "./src/mintHands";
import { sendMints, sendTransaction } from "./src/sendTx";
import { createShardId, loadShardId, storeShardId } from "./src/shard";
import { createUsers, loadUsers, storeUsers } from "./src/users";
import { wait } from "./src/wait";

const USERS_FILE_NAME = ".users";
const SHARD_ID_FILE_NAME = ".shard";
const APPROVERS_FILE_NAME = ".approvers";

const DEFAULT_TRANSFER_FEE = 100;

if (require.main === module) {
    const rpcUrl = config.get<string>("rpc_url")!;
    const networkId = config.get<string>("network_id")!;
    const passphrase = config.get<string>("passphrase");
    const payer = config.get<string>("payer");

    const sendgridApiKey = config.get<string>("sendgrid.api_key");
    const sendgridTo = config.get<string>("sendgrid.to");

    if (sendgridApiKey != null) {
        if (sendgridTo == null) {
            throw Error("You should set sendgrid.to");
        }
        console.log(`Tick-tock will send an notification to ${sendgridTo}`);
    }

    if (!PlatformAddress.check(payer)) {
        throw Error(`Invalid payer ${payer}`);
    }

    const sdk = new SDK({ server: rpcUrl, networkId });
    (async () => {
        const users = await loadUsers(USERS_FILE_NAME).catch((err: Error) => {
            console.error(err.message);
            return createUsers(sdk, passphrase).then(
                async (createdUsers): Promise<string[]> => {
                    await storeUsers(USERS_FILE_NAME, createdUsers);
                    return createdUsers;
                }
            );
        });

        const shardId = await loadShardId(SHARD_ID_FILE_NAME).catch(
            (err: Error) => {
                console.error(err.message);
                return createShardId(sdk, payer, passphrase).then(async id => {
                    console.log(`Shard(${id}) is created`);
                    await storeShardId(SHARD_ID_FILE_NAME, id);
                    return id;
                });
            }
        );

        const [
            hourApprover,
            minuteApprover,
            secondApprover
        ] = await loadApprovers(APPROVERS_FILE_NAME).catch((err: Error) => {
            console.error(err.message);
            return createApprovers(sdk, passphrase).then(
                async ([approver1, approver2, approver3]) => {
                    console.log(`Hour approver(${approver1}) is created`);
                    console.log(`Minute approver(${approver2}) is created`);
                    console.log(`Second approver(${approver3}) is created`);
                    await storeApprovers(
                        APPROVERS_FILE_NAME,
                        approver1,
                        approver2,
                        approver3
                    );
                    return [approver1, approver2, approver3];
                }
            );
        });

        // Activate the approvers
        await activateApprovers(sdk, {
            approvers: [hourApprover, minuteApprover, secondApprover],
            payer,
            passphrase
        });

        const mintedDate = new Date();
        const mints = mintHands(
            sdk,
            shardId,
            users,
            mintedDate,
            hourApprover,
            minuteApprover,
            secondApprover
        );

        const [mintHashes, nextSeq] = await sendMints(sdk, mints, {
            payer,
            passphrase
        });
        let seq = nextSeq; // TODO: quirks because of tslint
        let fee = DEFAULT_TRANSFER_FEE;

        for (const hash of mintHashes) {
            let i = 0;
            for (; i < 100; i += 1) {
                if (await sdk.rpc.chain.containsTransaction(hash)) {
                    break;
                }
                const error = await sdk.rpc.chain.getErrorHint(hash);
                if (error != null) {
                    throw Error(`Cannot mint the clock hand: ${error}`);
                }
                await wait(1_000);
            }
            if (i === 100) {
                throw Error("Cannot mint hands");
            }
        }

        console.log("Clock hands are minted");
        let hourAsset = mints[0].getMintedAsset();
        let minuteAsset = mints[1].getMintedAsset();
        let secondAsset = mints[2].getMintedAsset();

        const hourType = hourAsset.assetType;
        const minuteType = minuteAsset.assetType;
        const secondType = secondAsset.assetType;

        let pendings: [string, Asset, Asset, Asset, Date, number][] = [];

        let previousDate = mintedDate;
        let numberOfSentTransaction = 0;
        let numberOfFailedTransaction = 0;
        const transferFunction = async () => {
            try {
                const current = new Date();
                const hourChanged =
                    current.getUTCHours() !== previousDate.getUTCHours();
                const minuteChanged =
                    hourChanged ||
                    current.getUTCMinutes() !== previousDate.getUTCMinutes();
                const unshuffledInputs = [];
                const outputs = [];
                if (hourChanged) {
                    outputs.push(
                        sdk.core.createAssetTransferOutput({
                            assetType: hourType,
                            shardId,
                            quantity: 1,
                            recipient: users[current.getUTCHours()]
                        })
                    );
                    unshuffledInputs.push(hourAsset.createTransferInput());
                }

                if (minuteChanged) {
                    outputs.push(
                        sdk.core.createAssetTransferOutput({
                            assetType: minuteType,
                            shardId,
                            quantity: 1,
                            recipient: users[current.getUTCMinutes()]
                        })
                    );
                    unshuffledInputs.push(minuteAsset.createTransferInput());
                }

                outputs.push(
                    sdk.core.createAssetTransferOutput({
                        assetType: secondType,
                        shardId,
                        quantity: 1,
                        recipient: users[current.getUTCSeconds()]
                    })
                );
                unshuffledInputs.push(secondAsset.createTransferInput());

                const inputs = shuffle<AssetTransferInput>(unshuffledInputs);

                let metadata = `Current time is ${current}`;
                const noSecondApprover = !p99();
                if (noSecondApprover) {
                    metadata = `${metadata} : No second approver`;
                }
                const noMinuteApprover = minuteChanged && !p99();
                if (noMinuteApprover) {
                    metadata = `${metadata} : No minute approver`;
                }
                const noHourApprover = hourChanged && !p99();
                if (noHourApprover) {
                    metadata = `${metadata} : No hour approver`;
                }

                const transfer = sdk.core.createTransferAssetTransaction({
                    inputs,
                    outputs,
                    metadata
                });
                await sdk.key.signTransactionInput(transfer, 0, { passphrase });
                const approvers = [];
                if (!noSecondApprover) {
                    approvers.push(secondApprover);
                }

                if (minuteChanged) {
                    await sdk.key.signTransactionInput(transfer, 1, {
                        passphrase
                    });
                    if (!noMinuteApprover) {
                        approvers.push(minuteApprover);
                    }
                    if (hourChanged) {
                        await sdk.key.signTransactionInput(transfer, 2, {
                            passphrase
                        });
                        if (!noHourApprover) {
                            approvers.push(hourApprover);
                        }
                    }
                }
                for (const approver of shuffle<string>(approvers)) {
                    await approve(sdk, transfer, approver, passphrase);
                }

                numberOfSentTransaction += 1;
                const hash = await sendTransaction(
                    sdk,
                    payer,
                    passphrase,
                    seq,
                    fee,
                    transfer
                );
                if (noSecondApprover || noMinuteApprover || noHourApprover) {
                    numberOfFailedTransaction += 1;
                    console.log(
                        `Send failed transaction at ${current}.hash: ${hash}. metadata: ${metadata}. seq: ${seq}`
                    );

                    // Increase the fee of the next transaction to guarantee the transaction propagation.
                    fee = Math.min(Math.floor(fee * 1.5), 1_000);

                    // Pause sending transactions for a while.
                    setTimeout(transferFunction, 30_000);
                    return;
                }
                console.log(
                    `Clock hands are moved at ${current}. hash: ${hash}. seq: ${seq}`
                );
                pendings.push([
                    hash.value,
                    hourAsset,
                    minuteAsset,
                    secondAsset,
                    current,
                    seq
                ]);

                let assetIndex = 0;
                if (hourChanged) {
                    hourAsset = transfer.getTransferredAsset(assetIndex);
                    assetIndex += 1;
                }
                if (minuteChanged) {
                    minuteAsset = transfer.getTransferredAsset(assetIndex);
                    assetIndex += 1;
                }
                secondAsset = transfer.getTransferredAsset(assetIndex);

                seq += 1;

                previousDate = current;
            } catch (ex) {
                console.error(ex);
            }
            const timeout = Math.max(Math.floor(Math.random() * 3_000), 500);
            setTimeout(transferFunction, timeout);
        };

        let numberOfAcceptedTransactions = 0;
        let numberOfRejectedTransactions = 0;
        let numberOfExpiredTransactions = 0;
        const resultFunction = async () => {
            try {
                while (pendings.length !== 0) {
                    const hash = pendings[0][0];
                    if (await sdk.rpc.chain.containsTransaction(hash)) {
                        numberOfAcceptedTransactions += 1;
                        // Decrease the fee because the previous transaction succeed.
                        fee = Math.floor(
                            Math.max(DEFAULT_TRANSFER_FEE, fee / 2)
                        );
                        pendings.pop();
                        break;
                    }
                    const current = pendings[0][4];
                    if (current.getTime() + 30 * 1_000 < Date.now()) {
                        console.log(
                            "The transaction is not accepted over 30 seconds. Try a different transaction."
                        );
                        numberOfExpiredTransactions += 1;
                    } else {
                        const reason = await sdk.rpc.chain.getErrorHint(hash);
                        if (reason == null) {
                            console.log(
                                `Wait the result of ${hash} sent at ${current}`
                            );
                            setTimeout(resultFunction, 1_000);
                            return;
                        }
                        console.log(
                            `Tx(${hash} sent at ${current} failed: ${reason}`
                        );
                        numberOfRejectedTransactions += 1;
                    }

                    // Increase the fee of the next transaction to guarantee the transaction propagation.
                    fee = Math.floor(fee * 1.5);
                    hourAsset = pendings[0][1];
                    minuteAsset = pendings[0][2];
                    secondAsset = pendings[0][3];
                    seq = pendings[0][5];
                    pendings = [];
                }

                setTimeout(resultFunction, 500);
            } catch (ex) {
                console.error(ex);
            }
        };
        setTimeout(resultFunction, 500);

        setTimeout(transferFunction, 1_000);

        let lastDailyReportSentDate = new Date().getUTCDate();
        const dailyReport = async () => {
            const now = new Date();
            const currentDate = now.getUTCDate();
            if (lastDailyReportSentDate === currentDate) {
                return;
            }

            try {
                const total = numberOfSentTransaction;
                const failed = numberOfFailedTransaction;
                numberOfSentTransaction = 0;
                numberOfFailedTransaction = 0;

                const lines = [
                    `Tick-tock is using ${payer}.`,
                    `It sent ${total} transactions and ${failed} of them are intentionally failed transactions.`,
                    `${numberOfAcceptedTransactions} are accepted. ${numberOfRejectedTransactions} are rejected.`,
                    `${numberOfExpiredTransactions} are retried because it's not accepted over 30 seconds.`
                ];

                const text = lines.map(line => `${line}<br />`).join("\r\n");
                await sendEMail(
                    sendgridApiKey,
                    sendgridTo,
                    networkId,
                    text,
                    now.toUTCString()
                );

                lastDailyReportSentDate = currentDate;
            } catch (ex) {
                console.error(ex.message);
            }
        };
        setInterval(dailyReport, 60 * 1_000);
    })().catch(console.error);
}

function p99(): boolean {
    return Math.random() * 100 < 99;
}
