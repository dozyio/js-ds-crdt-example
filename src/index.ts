import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { prefixLogger } from '@libp2p/logger'
import { peerIdFromKeys } from '@libp2p/peer-id'
import { tcp } from '@libp2p/tcp'
import { multiaddr } from '@multiformats/multiaddr'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import Fastify from 'fastify'
import { createHelia, type HeliaLibp2p } from 'helia'
import { type Blockstore } from 'interface-blockstore'
import { Key, type Datastore } from 'interface-datastore'
import { createLibp2p } from 'libp2p'
import debug from 'weald'
import config from './config.json' with { type: 'json' }
import type { Libp2p, PeerId } from '@libp2p/interface'
import { CRDTDatastore, defaultOptions, msgIdFnStrictNoSign, PubSubBroadcaster, type CRDTLibp2pServices, type Options } from 'js-ds-crdt'
import { bitswap } from '@helia/block-brokers'
import { ping } from '@libp2p/ping';

const postKVOpts = {
  schema: {
    body: {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'string' } // value is a base64 encoded string
      }
    }
  }
}

const postConnectOpts = {
  schema: {
    body: {
      type: 'object',
      required: ['ma'],
      properties: {
        ma: { type: 'string' }
      }
    }
  }
}

interface KVRequestBody {
  value: string
}

interface ConnectRequestBody {
  ma: string
}

async function newCRDTDatastore(peerId: PeerId, port: number | string, topic: string = 'test', datastore: Datastore, blockstore: Blockstore, options?: Partial<Options>): Promise<CRDTDatastore> {
  const store = datastore
  const namespace = new Key('/test')
  const dagService = await createNode(peerId, port, datastore, blockstore)
  const broadcaster = new PubSubBroadcaster(dagService.libp2p, topic, prefixLogger('crdt').forComponent('pubsub'))

  let opts
  if (options !== undefined) {
    opts = { ...defaultOptions(), ...options }
  } else {
    opts = defaultOptions()
  }

  return new CRDTDatastore(store, namespace, dagService, broadcaster, opts)
}

async function createNode(peerId: PeerId, port: number | string, datastore: Datastore, blockstore: Blockstore): Promise<HeliaLibp2p<Libp2p<CRDTLibp2pServices>>> {
  let libp2pHost = '127.0.0.1'
  if (process.env.LIBP2P_HOST !== null && process.env.LIBP2P_HOST !== undefined) {
    libp2pHost = process.env.LIBP2P_HOST
  }

  const libp2p = await createLibp2p({
    peerId,
    addresses: {
      listen: [
        `/ip4/${libp2pHost}/tcp/${port}`,
      ]
    },
    transports: [
      tcp(),
    ],
    connectionEncryption: [
      noise()
    ],
    streamMuxers: [
      yamux()
    ],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    connectionMonitor: {
      // reenabled after https://github.com/libp2p/js-libp2p/pull/2671
      enabled: false,
    },
    connectionManager: {
      minConnections: 1
    },
    services: {
      identify: identify(),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        msgIdFn: msgIdFnStrictNoSign,
        ignoreDuplicatePublishError: true,
        tagMeshPeers: true
      }),
      ping: ping()
    }
  })

  const blockBrokers = [bitswap()]

  const h = await createHelia({
    datastore,
    blockstore,
    libp2p,
    blockBrokers,
    dns: undefined
  })

  // const topic = 'globaldb-example'
  // const handler = (msg) => {
  //   if (msg.topic === `${topic}-net`) {
  //     console.log(`${topic}-net message`, msg)
  //   } else if (msg.topic === `${topic}`) {
  //     console.log(`${topic} message`, msg)
  //   }
  // }
  //
  // libp2p.services.pubsub.addEventListener('message', handler)
  //
  // libp2p.services.pubsub.subscribe(`${topic}-net`)

  return h
}

function hexToUint8Array(hexString: string): Uint8Array {
  if (hexString.length % 2 !== 0) {
    throw new Error('Invalid hex string')
  }

  const arrayBuffer = new Uint8Array(hexString.length / 2)

  for (let i = 0; i < hexString.length; i += 2) {
    const byteValue = parseInt(hexString.slice(i, i + 2), 16)
    arrayBuffer[i / 2] = byteValue
  }

  return arrayBuffer
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const length = binaryString.length
  const bytes = new Uint8Array(length)

  for (let i = 0; i < length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  return bytes
}

function uint8ArrayToBase64(uint8Array: Uint8Array): string {
  let binaryString = ''
  for (let i = 0; i < uint8Array.length; i++) {
    binaryString += String.fromCharCode(uint8Array[i])
  }
  return btoa(binaryString)
}

async function startServer(datastore: CRDTDatastore, httpHost: string, httpPort: number): Promise<void> {
  const fastify = Fastify({
    logger: true
  })

  fastify.get('/health', async (request, reply) => {
    return 'ok'
  })

  fastify.get('/dag', async (request, reply) => {
    await datastore.printDAG()
  })

  fastify.get('/*', async (request, reply) => {
    const { '*': key } = request.params as { '*': string }

    try {
      const value = await datastore.get(new Key(key))

      if (value === null) {
        await reply.status(404).send({ error: 'not found' })
        return
      }

      if (value === undefined) {
        throw new Error('unknown error')
      }

      return { value: uint8ArrayToBase64(value) }
    } catch (err) {
      fastify.log.error(err)
      await reply.status(500).send({ error: err })
    }
    return { success: true }
  })

  fastify.delete('/*', async (request, reply) => {
    const { '*': key } = request.params as { '*': string }

    try {
      await datastore.delete(new Key(key))

      return { success: true }
    } catch (err) {
      fastify.log.error(err)
      await reply.status(500).send({ error: err })
    }
    return { success: true }
  })

  fastify.post<{ Body: ConnectRequestBody }>('/connect', postConnectOpts, async (request, reply) => {
    const { ma } = request.body
    try {
      const addr = multiaddr(ma)
      await datastore.dagService.libp2p.dial(addr)
      return { success: true }
    } catch (err) {
      fastify.log.error(err)
      await reply.status(500).send({ error: 'Failed to connect' })
    }
  })

  fastify.post<{ Body: KVRequestBody }>('/*', postKVOpts, async (request, reply) => {
    const { value } = request.body
    const { '*': key } = request.params as { '*': string }
    const datastoreValue = base64ToUint8Array(value)

    try {
      await datastore.put(new Key(key), datastoreValue)
      return { success: true }
    } catch (err) {
      fastify.log.error(err)
      await reply.status(500).send({ error: 'Failed to store data' })
    }
  })

  try {
    const multiaddrs = datastore.dagService.libp2p.getMultiaddrs()

    await fastify.listen({ host: httpHost, port: httpPort })
    // eslint-disable-next-line no-console
    console.log(`HTTP Server running on http://${httpHost}:${httpPort}/`)
    multiaddrs.forEach(ma => {
      // eslint-disable-next-line no-console
      console.log('Libp2p running on', ma.toString())
    })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

export default async function newTestServer(): Promise<CRDTDatastore> {
  let publicKey = config.peers[0].public_key
  let privateKey = config.peers[0].private_key

  if (process.env.PUBLIC_KEY !== null && process.env.PUBLIC_KEY !== undefined) {
    publicKey = process.env.PUBLIC_KEY
  }
  if (process.env.PRIVATE_KEY !== null && process.env.PRIVATE_KEY !== undefined) {
    privateKey = process.env.PRIVATE_KEY
  }

  if (publicKey === null || publicKey === undefined || publicKey === '') {
    throw new Error('PUBLIC_KEY must be set')
  }

  if (privateKey === null || privateKey === undefined || privateKey === '') {
    throw new Error('PRIVATE_KEY must be set')
  }

  const peerId = await peerIdFromKeys(
    hexToUint8Array(publicKey),
    hexToUint8Array(privateKey)
  )

  let libp2pPort: number | string = 6000
  if (process.env.LIBP2P_PORT !== null && process.env.LIBP2P_PORT !== undefined) {
    libp2pPort = process.env.LIBP2P_PORT
  }

  let gossipSubTopic = 'globaldb-example'
  if (process.env.GOSSIP_SUB_TOPIC !== null && process.env.GOSSIP_SUB_TOPIC !== undefined) {
    gossipSubTopic = process.env.GOSSIP_SUB_TOPIC
  }

  let httpHost = '127.0.0.1'
  if (process.env.HTTP_HOST !== null && process.env.HTTP_HOST !== undefined) {
    httpHost = process.env.HTTP_HOST
  }

  let httpPort = 3000
  if (process.env.HTTP_PORT !== null && process.env.HTTP_PORT !== undefined) {
    httpPort = parseInt(process.env.HTTP_PORT)
  }

  const datastore = new MemoryDatastore()
  const blockstore = new MemoryBlockstore()

  const opts: Partial<Options> = {
    putHook: (key: string, value: Uint8Array) => {
      console.log(`Added: [${new Key(key).toString()}] -> ${new TextDecoder().decode(value)}`)
    },
    deleteHook: (key: string) => {
      console.log(`Removed: [${new Key(key).toString()}]`)
    },
    loggerPrefix: 'crdt'
  }

  const crdtDatastore = await newCRDTDatastore(peerId, libp2pPort, gossipSubTopic, datastore, blockstore, opts)

  await startServer(crdtDatastore, httpHost, httpPort)

  return crdtDatastore
}


const commands = `
> (l)ist                      -> list items in the store
> (g)get <key>                -> get value for a key
> (p)ut <key> <value>         -> store value on a key
> (d)elete <key>              -> delete a key
> (c)onnect <multiaddr>       -> connect a multiaddr
> print                       -> print DAG
> debug <on/off/peers/subs>   -> enable/disable debug logging
                                 show connected peers
                                 show pubsub subscribers
> exit                        -> quit
`;

function printErr(err: string) {
  console.log("error:", err);
  console.log("> ");
}

function list(ds: CRDTDatastore) {
  console.log('todo')
}

async function get(ds: CRDTDatastore, key: string) {
  const k = new Key(key);
  const value = await ds.get(k);
  if (value) {
    console.log(`[${k.toString()}] -> ${value}`);
  } else {
    printErr('Key not found');
  }
}

async function put(ds: CRDTDatastore, key: string, value: string) {
  const v = new TextEncoder().encode(value)
  await ds.put(new Key(key), v);
  console.log(`Added: [${key}] -> ${value}`);
}

async function deleteKey(ds: CRDTDatastore, key: string) {
  await ds.delete(new Key(key))
}

function debugCmd(ds: CRDTDatastore, option: string) {
  switch (option) {
    case "on":
      debug.enable('*')
      break;
    case "off":
      debug.enable('-*')
      break;
    case "peers":
      ds.dagService.libp2p.getPeers().forEach(peerId => {
        console.log(peerId.toString())
      })
      break;
    case "subs":
      ds.dagService.libp2p.services.pubsub.getSubscribers("globaldb-example").forEach(peerId => {
        console.log(peerId.toString())
      })
      break;
    default:
      printErr("Unknown debug option");
  }
}

async function connect(ds: CRDTDatastore, ma: string) {
  const maDialable = multiaddr(ma)
  try {
    const conn = await ds.dagService.libp2p.dial(maDialable)
    console.log(`Connected to ${conn.remoteAddr.toString()}`);
  } catch (err) {
    printErr('Failed to connect')
  }
}

async function print(ds: CRDTDatastore) {
  ds.printDAG()
}

const crdtDatastore = await newTestServer()

const rl = readline.createInterface({ input, output })

console.log(commands)

let quit = false

while (true && !quit) {
  const answer = await rl.question('> ')

  const fields = answer.trim().split(/\s+/);

  if (fields.length === 0) {
    console.log(commands)
    continue;
  }

  const cmd = fields[0];

  switch (cmd) {
    case "exit":
    case "quit":
      quit = true
      process.exit(0);
      break;
    case "?":
    case "help":
    case "h":
      console.log(commands);
      break;
    case "debug":
      if (fields.length < 2) {
        printErr("debug <on/off/peers/subs>");
        break;
      }
      debugCmd(crdtDatastore, fields[1]);
      break;
    case "l":
    case "list":
      list(crdtDatastore);
      break;
    case "g":
    case "get":
      if (fields.length < 2) {
        printErr("get <key>");
        break;
      }
      get(crdtDatastore, fields[1]);
      break;
    case "p":
    case "put":
      if (fields.length < 3) {
        printErr("put <key> <value>");
        break;
      }
      put(crdtDatastore, fields[1], fields.slice(2).join(" "));
      break;
    case "d":
    case "delete":
      if (fields.length < 2) {
        printErr("delete <key>");
        break;
      }
      deleteKey(crdtDatastore, fields[1]);
      break;
    case "c":
    case "connect":
      if (fields.length < 2) {
        printErr("connect <multiaddr>");
        break;
      }
      await connect(crdtDatastore, fields[1]);
      break;
    case "c":
    case "connect":
      if (fields.length < 2) {
        printErr("connect <multiaddr>");
        break;
      }
      await connect(crdtDatastore, fields[1]);
      break;
    case "print":
      print(crdtDatastore);
      break;
    default:
      printErr(`Unknown command: ${cmd}`);
  }

  console.log('> ')
}

rl.close()
