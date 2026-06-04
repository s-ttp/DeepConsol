import type { Playbook } from "./types.js";

export const SEED_PLAYBOOKS: Omit<Playbook, "id">[] = [
  {
    title: "LTE Attach Failure",
    category: "Mobility / EPS",
    symptoms: [
      "UE cannot register; reports 'No service' or 'Emergency calls only'",
      "MME reports Attach Reject with EMM cause #15 / #11 / #7 / #14",
      "S1AP UE Context Release after initial UE message",
    ],
    questions: [
      "Is the failure isolated to one UE, one cell, one TAC, or the whole MME pool?",
      "Which EMM cause code is being returned?",
      "Has the IMSI been provisioned in HSS for the correct PLMN and APN?",
      "Are S6a Diameter peers up between MME and HSS?",
      "Are there recent SW/config changes on MME, HSS, or eNodeB?",
    ],
    commands: [
      "show ue context summary | include <imsi>",
      "show s1ap statistics | include attach",
      "diagnose s6a peer status",
      "show running-config tac <tac-id>",
      "tail -f /var/log/mme/attach.log | grep <imsi>",
    ],
    expected_outputs: [
      "UE context absent or in INACTIVE state",
      "S1AP Initial UE Message followed by Attach Reject with cause",
      "S6a ULR-ULA succeeds with experimental result code 2001",
    ],
    interpretation: [
      "Cause #15 (No suitable cells in tracking area) → TAI mismatch between eNodeB and MME service area",
      "Cause #11 (PLMN not allowed) → roaming agreement / forbidden PLMN list issue",
      "Cause #7 (EPS services not allowed) → subscriber profile in HSS lacks EPS subscription",
      "Cause #14 (EPS services not allowed in this PLMN) → operator-determined barring",
    ],
    next_steps: [
      "If cause #7/#14 → request HSS team to verify subscription profile",
      "If cause #15 → audit TAI list configured on the eNodeB vs MME service area",
      "If S6a peer down → check Diameter base connection and DRA routing",
      "Open ticket with vendor support if EMM cause is non-standard",
    ],
    escalation_template:
      "Subject: LTE Attach Failure — IMSI {imsi}, MME {mme}, TAC {tac}\\n\\nObservation: {summary}\\nEMM cause: {cause}\\nFirst seen: {first_seen_utc}\\nScope: {scope_one_ue|cell|tac|pool}\\nRecent changes: {recent_changes}\\nLogs collected: {log_paths}\\nNext owner: {team}",
  },
  {
    title: "VoLTE Call Drop",
    category: "Voice / IMS",
    symptoms: [
      "Calls drop within 5–60 seconds of answer",
      "RTP one-way audio followed by BYE",
      "P-CSCF reports SIP 408 / 480 / 487 mid-call",
    ],
    questions: [
      "At which leg is the BYE originated — UE, P-CSCF, S-CSCF, MGW?",
      "Is the dedicated bearer (QCI 1) being established before ringing?",
      "Is RTCP being received in both directions?",
      "Has there been a recent change to SBC or MGW codec policy?",
    ],
    commands: [
      "show volte session summary",
      "show qci-bearer statistics dedicated",
      "tcpdump -i any -nn -s0 'port 5060 or port 4060' -w /tmp/sip.pcap",
      "show sbc media-statistics | include packet_loss",
    ],
    expected_outputs: [
      "Active VoLTE sessions list",
      "QCI 1 bearer establishment success rate ~99%+",
      "SIP INVITE → 100 → 180 → 200 → ACK exchange in pcap",
    ],
    interpretation: [
      "BYE from network with cause Q.850 #16 → normal release; not a drop",
      "BYE from UE with cause #41 → temporary failure, often radio",
      "RTP timeout with no RTCP → media plane / bearer collapse, check QCI 1",
      "Codec mismatch in SDP → SBC or MGW transcoding issue",
    ],
    next_steps: [
      "Correlate drop time with eNodeB handover stats — possible HO failure",
      "If media-only failure with signaling intact → escalate to transport team",
      "If QCI 1 not established → escalate to PCRF/PGW team",
    ],
    escalation_template:
      "Subject: VoLTE call drop investigation — IMS {ims_node}\\n\\nObservation: drops within {seconds}s of answer\\nBYE originator: {leg}\\nMedia symptoms: {media}\\nPcap: {pcap_path}\\nNext owner: {team}",
  },
  {
    title: "5G Registration Reject",
    category: "5GC",
    symptoms: [
      "UE shows '5G unavailable' and falls back to LTE",
      "AMF logs Registration Reject with 5GMM cause",
      "N1/N2 procedures terminate at Identity Request stage",
    ],
    questions: [
      "Which 5GMM cause is being returned?",
      "Is the AUSF/UDM responsive on SBI?",
      "Has the UE been provisioned with 5G subscription (SUPI / NSSAI)?",
      "Is the requested S-NSSAI supported by the AMF and gNB?",
    ],
    commands: [
      "show amf registration-stats | include reject",
      "curl -sk https://<ausf>:8443/nausf-auth/v1/health",
      "show udm subscription <supi>",
      "show n2 statistics | include registration",
    ],
    expected_outputs: [
      "Registration reject count and cause distribution",
      "AUSF health 200 OK",
      "UDM subscription record with allowed NSSAI",
    ],
    interpretation: [
      "Cause #7 (5GS services not allowed) → subscription does not include 5GS",
      "Cause #11 (PLMN not allowed) → roaming or PLMN config issue",
      "Cause #62 (No network slices available) → S-NSSAI not provisioned/allowed",
    ],
    next_steps: [
      "If cause #62 → verify slice configuration on AMF, NSSF, gNB",
      "If AUSF unhealthy → escalate to core team / SBI mesh owner",
      "If isolated to one UE → check IMSI/SUPI provisioning in UDM",
    ],
    escalation_template:
      "Subject: 5G Registration Reject — SUPI {supi}\\n\\n5GMM cause: {cause}\\nAMF: {amf}\\nAUSF/UDM health: {sbi_health}\\nFirst seen: {first_seen}\\nNext owner: {team}",
  },
  {
    title: "High Packet Loss",
    category: "Transport",
    symptoms: [
      "Ping loss > 1% on backhaul interface",
      "Application latency p99 spike",
      "TCP retransmissions elevated on critical flows",
    ],
    questions: [
      "Is loss directional or bidirectional?",
      "Is loss correlated with link utilization?",
      "Are CRC / framing errors incrementing on the interface?",
      "Has there been a recent change in routing or QoS policy?",
    ],
    commands: [
      "show interfaces <if> | include error|drop|discard",
      "ping -c 1000 -i 0.2 <peer>",
      "show queue qos <if>",
      "show ip route <prefix>",
    ],
    expected_outputs: [
      "Interface counters: input errors, CRC, output drops",
      "Ping summary with RTT distribution and loss %",
      "QoS queue depth / drops per class",
    ],
    interpretation: [
      "Rising CRC + clean optical levels → cable / patch-panel issue",
      "Output drops only → congestion, check QoS",
      "Bidirectional loss with no errors → upstream path issue",
    ],
    next_steps: [
      "If physical errors → schedule patch / clean fiber",
      "If congestion → escalate capacity to transport planning",
      "If routing flap → escalate to IGP/BGP team",
    ],
    escalation_template:
      "Subject: High packet loss on {interface}\\n\\nLoss: {pct}%\\nDirection: {direction}\\nCounters: {counters}\\nRecent changes: {changes}\\nNext owner: {team}",
  },
  {
    title: "Cell Down",
    category: "RAN",
    symptoms: [
      "Cell shows OOS / locked / Service unavailable in OSS",
      "PRB utilization drops to 0",
      "Alarms: Sync loss / S1 link down / RU not reachable",
    ],
    questions: [
      "Is it one cell, one site, or multiple sites?",
      "Is the alarm RU/BBU/Transport/Sync?",
      "Was a planned activity (power, SW upgrade) in window?",
      "Any environmental alarm — temperature, power, mains failure?",
    ],
    commands: [
      "show cell <cell-id> status",
      "show ru status site <site-id>",
      "show s1 link status",
      "show sync source",
    ],
    expected_outputs: [
      "Cell admin/oper state",
      "RU/BBU CPRI link status",
      "S1-MME peer connectivity",
      "PTP / GNSS sync state",
    ],
    interpretation: [
      "RU not reachable → fiber/CPRI/optic issue at site",
      "S1 link down → backhaul issue or core unreachable",
      "Sync loss → PTP master or GNSS antenna issue",
    ],
    next_steps: [
      "Dispatch field if site isolated and not power-related",
      "If transport-related → handover to transport NOC",
      "If software unstable post-upgrade → engage vendor for rollback",
    ],
    escalation_template:
      "Subject: Cell {cell_id} OOS at {site}\\n\\nDuration: {duration}\\nAlarm: {alarm}\\nField dispatch: {y_n}\\nNext owner: {team}",
  },
  {
    title: "Handover Failure",
    category: "RAN",
    symptoms: [
      "X2/Xn handover success rate drops",
      "UE drops or pingpong observed at cell edge",
      "Handover failure cause: Time-to-trigger expiry / RLF",
    ],
    questions: [
      "Source/target cell pair affected?",
      "Is failure intra-frequency, inter-frequency, or inter-RAT?",
      "Has neighbor relation table been updated recently?",
      "Are there overlap / coverage holes between source and target?",
    ],
    commands: [
      "show ho-stats source <cell> target <cell>",
      "show neighbor-relation source <cell>",
      "show measurement-config source <cell>",
    ],
    expected_outputs: [
      "Handover attempt / success / failure counts",
      "Neighbor relation list with X2/Xn status",
      "A3 offset / hysteresis / time-to-trigger settings",
    ],
    interpretation: [
      "High RLF before handover complete → coverage gap or fast fading",
      "Target prep failure → X2/Xn link or admission control on target",
      "Pingpong → A3 offset too aggressive",
    ],
    next_steps: [
      "Tune A3/TTT if pingpong dominant",
      "If coverage gap → propose tilt / power adjustment",
      "If X2 down → handover to transport team",
    ],
    escalation_template:
      "Subject: Handover failure {source}→{target}\\n\\nSuccess rate: {pct}%\\nDominant cause: {cause}\\nNext owner: {team}",
  },
];
