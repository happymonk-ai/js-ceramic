import type CID from 'cids'
import { validateLink } from "@ceramicnetwork/blockchain-utils-validation"
import { Caip10Link } from "@ceramicnetwork/stream-caip10-link"
import {
    AnchorStatus,
    StreamState,
    StreamConstructor,
    StreamHandler,
    SignatureStatus,
    CommitType,
    CeramicCommit,
    AnchorCommit,
    Context
} from "@ceramicnetwork/common"

const IPFS_GET_TIMEOUT = 60000 // 1 minute

export class Caip10LinkHandler implements StreamHandler<Caip10Link> {
    get type(): number {
      return Caip10Link.STREAM_TYPE_ID
    }

    get name(): string {
        return Caip10Link.STREAM_TYPE_NAME
    }

    get stream_constructor(): StreamConstructor<Caip10Link> {
        return Caip10Link
    }

    /**
     * Applies commit (genesis|signed|anchor)
     * @param commit - Commit to be applied
     * @param cid - Commit CID
     * @param context - Ceramic context
     * @param state - Stream state
     */
    async applyCommit(commit: CeramicCommit, cid: CID, context: Context, state?: StreamState): Promise<StreamState> {
        if (state == null) {
            return this._applyGenesis(commit, cid)
        }

        if ((commit as AnchorCommit).proof) {
            return this._applyAnchor(context, commit, cid, state);
        }

        return this._applySigned(commit, cid, state);
    }

    /**
     * Applies genesis commit
     * @param commit - Genesis commit
     * @param cid - Genesis commit CID
     * @private
     */
    async _applyGenesis (commit: any, cid: CID): Promise<StreamState> {
        if (commit.data) {
            throw new Error('Caip10Link genesis commit cannot have data')
        }

        // TODO - verify genesis commit
        const state = {
            type: Caip10Link.STREAM_TYPE_ID,
            content: null,
            next: {
                content: null
            },
            metadata: commit.header,
            signature: SignatureStatus.GENESIS,
            anchorStatus: AnchorStatus.NOT_REQUESTED,
            log: [{ cid, type: CommitType.GENESIS }]
        }

        if (!(state.metadata.controllers && state.metadata.controllers.length === 1)) {
            throw new Error('Exactly one controller must be specified')
        }

        return state
    }

    /**
     * Applies signed commit
     * @param commit - Signed commit
     * @param cid - Signed commit CID
     * @param state - Stream state
     * @private
     */
    async _applySigned (commit: any, cid: CID, state: StreamState): Promise<StreamState> {
        // TODO: Assert that the 'prev' of the commit being applied is the end of the log in 'state'
        let validProof = null
        try {
          validProof = await validateLink(commit.data)
        } catch (e) {
          throw new Error("Error while validating link proof for caip10-link signed commit: " + e.toString())
        }
        if (!validProof) {
            throw new Error('Invalid proof for signed commit')
        }

        if (state.signature !== SignatureStatus.GENESIS && (
          (
            state.anchorStatus === AnchorStatus.ANCHORED &&
            validProof.timestamp < state.anchorProof.blockTimestamp
          ) || (
            state.anchorStatus !== AnchorStatus.ANCHORED &&
            validProof.timestamp < state.next.metadata.lastUpdate
          )
        )) {
          throw new Error('Invalid commit, proof timestamp too old')
        }

        // TODO: handle CAIP-10 addresses in proof generation of 3id-blockchain-utils
        const account = validProof.account || validProof.address
        let [address, chainId] = account.split('@')  // eslint-disable-line prefer-const

        const addressCaip10 = [address, chainId].join('@')
        if (addressCaip10.toLowerCase() !== state.metadata.controllers[0].toLowerCase()) {
            throw new Error("Address doesn't match stream controller")
        }
        state.log.push({ cid, type: CommitType.SIGNED })
        return {
            ...state,
            signature: SignatureStatus.SIGNED,
            anchorStatus: AnchorStatus.NOT_REQUESTED,
            next: {
                content: validProof.did,
                metadata: {
                  ...state.metadata,
                  lastUpdate: validProof.timestamp // in case there are two updates after each other
                }
            }
        }
    }

    /**
     * Applies anchor commit
     * @param context - Ceramic context
     * @param commit - Anchor commit
     * @param cid - Anchor commit CID
     * @param state - Stream state
     * @private
     */
    async _applyAnchor (context: Context, commit: any, cid: CID, state: StreamState): Promise<StreamState> {
        // TODO: Assert that the 'prev' of the commit being applied is the end of the log in 'state'
        const proof = (await context.ipfs.dag.get(commit.proof, { timeout: IPFS_GET_TIMEOUT })).value;

        state.log.push({ cid, type: CommitType.ANCHOR })
        let content = state.content
        if (state.next?.content) {
            content = state.next.content
        }

        delete state.next
        delete state.anchorScheduledFor

        return {
            ...state,
            content,
            anchorStatus: AnchorStatus.ANCHORED,
            anchorProof: proof,
        }
    }

}
