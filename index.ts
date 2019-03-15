import { SDK } from "codechain-sdk";

import { createWCCCRecipient } from "./src/createWCCCRecipient";
import { main } from "./src/main";
import { createMintOilTx, sendMintOilTx } from "./src/mintOil";
import { getConfig, getOilFromConfig, haveConfig } from "./src/util";

if (require.main === module) {
    (async () => {
        const rpcUrl = getConfig<string>("rpc_url");
        const networkId = getConfig<string>("network_id");
        const sdk = new SDK({ server: rpcUrl, networkId });

        const payer = getConfig<string>("payer.payer");
        const payerPassphrase = getConfig<string>("payer.passphrase");
        const reward = getConfig<number>("reward");
        const dropInterval = getConfig<number>("drop_interval");
        const excludedAccountList = getConfig<string[]>("exclude");

        const keyStore = await sdk.key.createLocalKeyStore();

        const cccRecipient = (haveConfig("ccc_recipient"))
            ? getConfig<string>("ccc_recipient")
            : (await createWCCCRecipient(sdk)).toString();

        let oil = await getOilFromConfig(sdk);
        if (oil == null) {
            const passphrase = getConfig<string>("oil.passphrase");
            const oilOwner = (await sdk.key.createAssetTransferAddress({keyStore, passphrase})).toString();
            const mintOilTx = createMintOilTx(sdk, oilOwner);
            const mintedOil = await sendMintOilTx(sdk, {
                payer, passphrase: payerPassphrase, keyStore, mintOilTx
            });
            oil = { tracker: mintOilTx.tracker(),
                owner: oilOwner,
                passphrase, asset: mintedOil };
            console.log(`New oil owner created: ${oilOwner}`);
            console.log(`New oil tracker ${mintOilTx.tracker()}`);
        }

        await main(sdk, keyStore, { payer, payerPassphrase, reward, dropInterval, excludedAccountList, cccRecipient, oil });
    })();
}
