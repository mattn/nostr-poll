import { createRxNostr, createRxForwardReq, uniq, verify } from 'https://esm.sh/rx-nostr';
import { nip19 } from 'https://esm.sh/nostr-tools@2.7.0';
import { filter, take, distinct, timeout } from 'https://esm.sh/rxjs@7.8.1';

// Wait for NostrLogin to be available
function initNostrLogin() {
  if (globalThis.NostrLogin) {
    globalThis.addEventListener('nlAuth', (e) => {
      console.log('nlAuth event:', e.detail);
      showStatus(`Authenticated: ${e.detail?.type || 'unknown'}`, 'success');
    });

    globalThis.addEventListener('nlLogout', () => {
      console.log('nlLogout event');
      showStatus('Logged out', 'success');
    });

    globalThis.NostrLogin.init({
      bunkers: ['nsec.app', 'nsecbunker.com'],
      methods: ['extension', 'local', 'connect'],
      darkMode: false
    });
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNostrLogin);
} else {
  initNostrLogin();
}

const rxNostr = createRxNostr({
  verifier: verify
});

const defaultRelays = [
  'wss://yabu.me'
];

rxNostr.setDefaultRelays(defaultRelays);

let pollEvent = null;
let selectedOption = null;
let currentFetchType = null;
let listSubscription = null;

function showStatus(message, type = 'loading') {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
}

function fetchPollEvents() {
  const events = [];
  let timeoutHandle;
  const startTime = Date.now();

  currentFetchType = 'list';

  return new Promise((resolve, reject) => {
    const rxReq = createRxForwardReq();

    listSubscription = rxNostr.use(rxReq).pipe(
      uniq(),
      timeout(10000)
    ).subscribe({
      next: (packet) => {
        if (currentFetchType !== 'list') {
          return;
        }
        const elapsed = Date.now() - startTime;
        if (elapsed > 6000) {
          return;
        }
        if (packet.event && packet.event.kind === 1068) {
          events.push(packet.event);
        }
      },
      error: (err) => {
        clearTimeout(timeoutHandle);
        if (currentFetchType === 'list' && events.length > 0) {
          displayPollList(events);
        }
        resolve(events);
      },
      complete: () => {
        clearTimeout(timeoutHandle);
        if (currentFetchType === 'list' && events.length > 0) {
          displayPollList(events);
        }
        resolve(events);
      }
    });

    rxReq.emit({
      kinds: [1068],
      limit: 20
    });

    timeoutHandle = setTimeout(() => {
      listSubscription?.unsubscribe();
      listSubscription = null;
      if (currentFetchType === 'list' && events.length > 0) {
        displayPollList(events);
      }
      resolve(events);
    }, 5000);
  });
}

function displayPollList(events) {
  const container = document.getElementById('poll-list-container');
  const sortedEvents = events
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 10);

  if (sortedEvents.length === 0) {
    showStatus('No poll events found', 'error');
    return;
  }

  container.innerHTML = `
    <h2>Recent Polls</h2>
    <ul class="poll-list">
      ${sortedEvents.map(event => {
        const title = event.content.slice(0, 100) + (event.content.length > 100 ? '...' : '');
        const nevent = nip19.neventEncode({ id: event.id });
        const date = new Date(event.created_at * 1000).toLocaleDateString('ja-JP');
        return `
          <li class="poll-list-item">
            <a href="#${escapeHtml(nevent)}" class="poll-list-link">
              <div class="poll-list-title">${escapeHtml(title)}</div>
              <div class="poll-list-date">${date}</div>
            </a>
          </li>
        `;
      }).join('')}
    </ul>
  `;

  showStatus('Polls loaded', 'success');
}

function fetchPollEvent(eventId) {
  console.log('Fetching event ID:', eventId);
  return new Promise((resolve, reject) => {
    const rxReq = createRxForwardReq();
    let packetCount = 0;

    const subscription = rxNostr.use(rxReq).pipe(
      filter((packet) => {
        packetCount++;
        console.log(`Packet #${packetCount}:`, {
          hasEvent: !!packet.event,
          eventId: packet.event?.id,
          expectedId: eventId,
          match: packet.event?.id === eventId,
          kind: packet.event?.kind,
          isKind1068: packet.event?.kind === 1068
        });
        return packet.event?.id === eventId && packet.event.kind === 1068;
      }),
      distinct((p) => p.event?.id),
      take(1),
      timeout(10000),
    ).subscribe({
      next: (packet) => {
        console.log('Received matching event:', packet.event);
        displayPoll(packet.event);
        subscription.unsubscribe();
        resolve();
      },
      error: (err) => {
        console.error('Fetch error:', err);
        showStatus(`Failed to fetch poll event: ${err.message}`, 'error');
        subscription.unsubscribe();
        reject(err);
      },
      complete: () => {
        console.log('Subscription completed');
        subscription.unsubscribe();
      }
    });

    console.log('Emitting request for event ID:', eventId);
    rxReq.emit({
      ids: [eventId],
      kinds: [1068]
    });
  });
}

async function getUserPubkey() {
  try {
    if (globalThis.NostrLogin) {
      return await globalThis.NostrLogin.getPubkey().catch(() => null);
    } else if (globalThis.nostr && typeof globalThis.nostr.getPublicKey === 'function') {
      return await globalThis.nostr.getPublicKey();
    }
    return null;
  } catch (error) {
    console.log('Failed to get user pubkey:', error);
    return null;
  }
}

async function checkUserVote(pollEventId) {
  let userPubkey = "";
  try {
    userPubkey = await getUserPubkey();
  } catch (error) {
    console.error('Error getting user pubkey:', error);
  }
  if (!userPubkey) return null;

  console.log('Checking vote for user:', userPubkey);

  return new Promise((resolve) => {
    const rxReq = createRxForwardReq();
    let latestVote = null;
    let latestTimestamp = 0;

    rxNostr.use(rxReq).pipe(
      filter((packet) =>
        packet.event?.pubkey === userPubkey &&
        packet.event.kind === 1068
      ),
      distinct((p) => p.event?.id),
      uniq(),
    ).subscribe({
      next: (packet) => {
        // Only consider the latest vote
        if (packet.event.created_at > latestTimestamp) {
          // Find the vote option
          for (const tag of packet.event.tags) {
            let optionId = null;
            if (tag[0] === 'poll_option' && tag[2]) {
              optionId = tag[2];
            } else if (tag[0] === 'response' && tag[1]) {
              optionId = tag[1];
            }

            if (optionId) {
              latestVote = optionId;
              latestTimestamp = packet.event.created_at;
              console.log('Found vote for option:', optionId, 'at', new Date(packet.event.created_at * 1000));
              break;
            }
          }
        }
      },
      error: () => resolve(latestVote),
      complete: () => resolve(latestVote)
    });

    rxReq.emit({
      kinds: [1018],
      authors: [userPubkey],
      '#e': [pollEventId]
    });

    setTimeout(() => resolve(latestVote), 3000);
  });
}

function fetchVoteResults(pollEventId) {
  console.log('Fetching votes for poll ID:', pollEventId);
  return new Promise((resolve) => {
    const userVotes = {}; // pubkey -> {optionId, timestamp}
    let eventCount = 0;
    const rxReq = createRxForwardReq();

    rxNostr.use(rxReq).pipe(
      filter((packet) =>
        packet.event.kind === 1068
      ),
      uniq(),
      timeout(5000)
    ).subscribe({
      next: (packet) => {
        eventCount++;
        console.log(`Vote event #${eventCount}:`, packet.event);

        // Find poll_option or response tag
        for (const tag of packet.event.tags) {
          let optionId = null;

          // Format 1: ['poll_option', '0', 'option_id']
          if (tag[0] === 'poll_option' && tag[2]) {
            optionId = tag[2];
          }
          // Format 2: ['response', 'option_id']
          else if (tag[0] === 'response' && tag[1]) {
            optionId = tag[1];
          }

          if (optionId) {
            const pubkey = packet.event.pubkey;
            const timestamp = packet.event.created_at;

            // Only keep the latest vote from each user
            if (!userVotes[pubkey] || userVotes[pubkey].timestamp < timestamp) {
              userVotes[pubkey] = { optionId, timestamp };
              console.log(`Updated vote for ${pubkey.slice(0, 8)}: ${optionId}`);
            }
            break;
          }
        }
      },
      error: () => {
        const votes = {};
        Object.values(userVotes).forEach(vote => {
          votes[vote.optionId] = (votes[vote.optionId] || 0) + 1;
        });
        console.log(`Total vote events received: ${eventCount}`);
        console.log('Final votes:', votes);
        resolve(votes);
      },
      complete: () => {
        const votes = {};
        Object.values(userVotes).forEach(vote => {
          votes[vote.optionId] = (votes[vote.optionId] || 0) + 1;
        });
        console.log(`Total vote events received: ${eventCount}`);
        console.log('Final votes:', votes);
        resolve(votes);
      }
    });

    console.log('Emitting filter:', {
      kinds: [1018],
      '#e': [pollEventId]
    });

    rxReq.emit({
      kinds: [1018],
      '#e': [pollEventId]
    });

    setTimeout(() => {
      const votes = {};
      Object.values(userVotes).forEach(vote => {
        votes[vote.optionId] = (votes[vote.optionId] || 0) + 1;
      });
      console.log(`Timeout - Total vote events received: ${eventCount}`);
      console.log('Timeout - Final votes:', votes);
      resolve(votes);
    }, 5000);
  });
}

function fetchAuthorProfile(pubkey) {
  return new Promise((resolve) => {
    const rxReq = createRxForwardReq();

    rxNostr.use(rxReq).pipe(
      filter((packet) =>
        packet.event.kind === 0
      ),
      uniq(),
      take(1),
      timeout(5000)
    ).subscribe({
      next: (packet) => {
        if (packet.event && packet.event.kind === 0) {
          try {
            const profile = JSON.parse(packet.event.content);
            resolve(profile);
          } catch (_) {
            resolve(null);
          }
        }
      },
      error: () => resolve(null),
      complete: () => {}
    });

    rxReq.emit({
      authors: [pubkey],
      kinds: [0]
    });

    setTimeout(() => resolve(null), 5000);
  });
}

function parsePollOptions(event) {
  console.log('Event tags:', event.tags);
  const options = [];
  for (const tag of event.tags) {
    if (tag[0] === 'option' && tag[2] !== undefined) {
      options.push({
        id: tag[1],
        text: tag[2]
      });
    }
  }
  console.log('Parsed options:', options);
  return options;
}

function parseEmojis(event) {
  const emojis = {};
  for (const tag of event.tags) {
    if (tag[0] === 'emoji' && tag[1] && tag[2]) {
      emojis[`:${tag[1]}:`] = tag[2];
    }
  }
  return emojis;
}

function replaceEmojis(text, emojis) {
  // Parse text and replace emoji shortcodes with img tags
  let parts = [text];

  for (const [shortcode, url] of Object.entries(emojis)) {
    const newParts = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        const segments = part.split(shortcode);
        for (let i = 0; i < segments.length; i++) {
          if (i > 0) {
            // Add emoji img element as object
            newParts.push({
              type: 'emoji',
              url: url,
              shortcode: shortcode
            });
          }
          newParts.push(segments[i]);
        }
      } else {
        newParts.push(part);
      }
    }
    parts = newParts;
  }

  // Build safe HTML
  return parts.map(part => {
    if (typeof part === 'string') {
      return escapeHtml(part);
    } else if (part.type === 'emoji') {
      return `<img src="${escapeHtml(part.url)}" alt="${escapeHtml(part.shortcode)}" class="custom-emoji" title="${escapeHtml(part.shortcode)}">`;
    }
    return '';
  }).join('');
}

async function displayPoll(event, showResults = false) {
  console.log('displayPoll called with event:', event);
  pollEvent = event;
  document.getElementById('poll-list-container').innerHTML = '';
  const container = document.getElementById('poll-container');
  const options = parsePollOptions(event);

  if (options.length === 0) {
    showStatus('No poll options found', 'error');
    return;
  }

  const question = event.content || 'Poll Question';

  // Parse custom emojis
  const emojis = parseEmojis(event);

  // Check if user already voted and get user info
  const userVotedOption = null //await checkUserVote(event.id);

  // If user voted and showResults is not explicitly set, show results
  if (userVotedOption && !showResults) {
    showResults = true;
  }

  // Show loading state if fetching results
  if (showResults) {
    showStatus('Loading results...', 'loading');
  }

  // Get current user info
  const currentUserPubkey = await getUserPubkey();
  let currentUserName = null;

  if (currentUserPubkey) {
    const userProfile = await fetchAuthorProfile(currentUserPubkey);
    currentUserName = userProfile?.name || userProfile?.display_name || currentUserPubkey.slice(0, 8) + '...';
  }

  console.log('User voted option:', userVotedOption);
  console.log('Current user:', currentUserPubkey?.slice(0, 8));

  // Fetch author profile
  const profile = await fetchAuthorProfile(event.pubkey);
  const authorName = profile?.name || profile?.display_name || event.pubkey.slice(0, 8) + '...';
  const authorPicture = profile?.picture || '';

  // Fetch vote results if needed
  let voteResults = {};
  let totalVotes = 0;
  if (showResults) {
    voteResults = await fetchVoteResults(event.id);
    totalVotes = Object.values(voteResults).reduce((sum, count) => sum + count, 0);
    showStatus('Results loaded', 'success');
  }

  // Find the voted option text
  let votedOptionText = '';
  if (userVotedOption) {
    const votedOpt = options.find(opt => opt.id === userVotedOption);
    votedOptionText = votedOpt ? votedOpt.text : `選択肢 ${userVotedOption}`;
  }

  container.innerHTML = `
        <div class="poll-question">${replaceEmojis(question, emojis)}</div>
        ${userVotedOption ? `
            <div class="user-voted-notice">
                ✓ 投票済み: "${replaceEmojis(votedOptionText, emojis)}"
                ${currentUserName ? `<br><small>アカウント: ${currentUserName}</small>` : ''}
            </div>
        ` : ''}
        <ul class="poll-options" id="options-list">
            ${options.map((opt, _) => {
              const votes = voteResults[opt.id] || 0;
              const percentage = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
              const isUserVote = userVotedOption === opt.id;
              console.log(`Option ${opt.id}: isUserVote=${isUserVote}, userVotedOption=${userVotedOption}`);
              return `
                    <li class="poll-option ${showResults ? 'with-results' : ''} ${isUserVote ? 'user-voted' : ''}" data-option-id="${escapeHtml(opt.id)}">
                        <span class="option-text">${replaceEmojis(opt.text, emojis)} ${isUserVote ? '<span class="voted-mark">✓</span>' : ''}</span>
                        ${showResults ? `<span class="option-votes">${votes}票 (${percentage}%)</span>` : ''}
                        ${showResults ? `<div class="vote-bar" style="width: ${percentage}%"></div>` : ''}
                    </li>
                `;
            }).join('')}
        </ul>
        <button class="vote-button" id="vote-btn" ${showResults ? '' : userVotedOption ? '' : 'disabled'}>${showResults ? '結果を更新' : userVotedOption ? '結果を表示' : '投票する'}</button>
        <div class="poll-meta">
            <div class="poll-author">
                ${authorPicture ? `<img src="${escapeHtml(authorPicture)}" alt="${escapeHtml(authorName)}" class="author-avatar">` : ''}
                <span>作成者: ${escapeHtml(authorName)}</span>
            </div>
            <div class="poll-time">${new Date(event.created_at * 1000).toLocaleString('ja-JP')}</div>
            ${showResults ? `<div class="poll-total">総投票数: ${totalVotes}</div>` : ''}
            ${currentUserPubkey ? `<div class="current-user">現在のアカウント: ${currentUserName || currentUserPubkey.slice(0, 8) + '...'}</div>` : ''}
        </div>
    `;

              container.classList.add('visible');

              if (!showResults) {
                if (userVotedOption) {
                  // User already voted, show results button
                  document.getElementById('vote-btn').addEventListener('click', async () => {
                    showStatus('Loading results...', 'loading');
                    await displayPoll(pollEvent, true);
                  });
                } else {
                  // User hasn't voted, show voting interface
                  document.querySelectorAll('.poll-option').forEach(option => {
                    option.addEventListener('click', () => {
                      document.querySelectorAll('.poll-option').forEach(o => o.classList.remove('selected'));
                      option.classList.add('selected');
                      selectedOption = option.dataset.optionId;
                      document.getElementById('vote-btn').disabled = false;
                    });
                  });

                  document.getElementById('vote-btn').addEventListener('click', submitVote);
                }
              } else {
                document.getElementById('vote-btn').addEventListener('click', async () => {
                  showStatus('Refreshing results...', 'loading');
                  await displayPoll(pollEvent, true);
                  showStatus('Results updated', 'success');
                });
              }

              showStatus('Poll loaded successfully', 'success');
            }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function submitVote() {
    if (selectedOption === null || !pollEvent) return;

    const voteBtn = document.getElementById('vote-btn');
    voteBtn.disabled = true;
    showStatus('投票を送信中...', 'loading');

    try {
      let signedEvent;
      let userPubkey;

      const voteEvent = {
        kind: 1018,
        content: '',
        tags: [
          ['e', pollEvent.id, '', 'poll'],
          ['poll_option', '0', selectedOption]
        ],
        created_at: Math.floor(Date.now() / 1000)
      };

      // Use nostr-login if available, otherwise try NIP-07
      if (globalThis.NostrLogin) {
        userPubkey = await globalThis.NostrLogin.getPubkey().catch(() => null);

        if (!userPubkey) {
          await globalThis.NostrLogin.launch();
          userPubkey = await globalThis.NostrLogin.getPubkey();
        }

        voteEvent.pubkey = userPubkey;
        showStatus(`署名を要求中... (${userPubkey.slice(0, 8)}...)`, 'loading');

        // Check if NIP-07 is available after login
        if (globalThis.nostr && typeof globalThis.nostr.signEvent === 'function') {
          signedEvent = await globalThis.nostr.signEvent(voteEvent);
        } else {
          signedEvent = await globalThis.NostrLogin.signEvent(voteEvent);
        }
      } else if (globalThis.nostr && typeof globalThis.nostr.signEvent === 'function') {
        userPubkey = await globalThis.nostr.getPublicKey();
        voteEvent.pubkey = userPubkey;
        signedEvent = await globalThis.nostr.signEvent(voteEvent);
      } else {
        throw new Error('Nostr拡張機能またはnostr-loginが必要です');
      }

      if (!signedEvent || !signedEvent.sig) {
        throw new Error('署名が無効です');
      }

      showStatus('リレーに送信中...', 'loading');
      await publishEvent(signedEvent);

      showStatus(`投票完了! (${userPubkey.slice(0, 8)}...)`, 'success');

      // Show results after voting
      setTimeout(() => {
        displayPoll(pollEvent, true);
      }, 1000);

    } catch (error) {
      console.error('Vote submission error:', error);
      if (error.message === 'Closed' || error.message.includes('closed')) {
        showStatus('ログインがキャンセルされました', 'error');
      } else {
        showStatus(`エラー: ${error.message}`, 'error');
      }
      voteBtn.disabled = false;
    }
  }

  function publishEvent(event) {
    return new Promise((resolve, reject) => {
      let successCount = 0;
      const subscription = rxNostr.send(event).subscribe({
        next: (packet) => {
          if (packet.ok) {
            successCount++;
          }
        },
        complete: () => {
          if (successCount > 0) {
            resolve();
          } else {
            reject(new Error('Failed to publish to any relay'));
          }
        },
        error: (err) => reject(err)
      });

      setTimeout(() => {
        subscription.unsubscribe();
        if (successCount > 0) {
          resolve();
        } else {
          reject(new Error('Publish timeout'));
        }
      }, 5000);
    });
  }

  async function init() {
    showStatus('Loading poll...', 'loading');

    const hash = globalThis.location.hash.slice(1);
    const urlParams = new URLSearchParams(globalThis.location.search);
    const nevent = hash || urlParams.get('id');

    if (!nevent) {
      await fetchPollEvents().catch((error) => {
        console.log('Fetch poll events error:', error);
      })
      return;
    }

    if (!nevent.startsWith('nevent1')) {
      showStatus('Invalid nevent format', 'error');
      return;
    }

    try {
      const decoded = nip19.decode(nevent);
      const eventId = decoded.data?.id || decoded.data;

      await fetchPollEvent(eventId).catch((error) => {
        console.log('Fetch poll event error:', error);
      })
    } catch (error) {
      console.error('Init error:', error);
      showStatus(`Error: ${error.message}`, 'error');
    }
  }

  globalThis.addEventListener('hashchange', () => {
    console.log('Hash changed to:', globalThis.location.hash);
    listSubscription?.unsubscribe();
    listSubscription = null;
    currentFetchType = 'single';

    const hash = globalThis.location.hash.slice(1);
    if (hash && hash.startsWith('nevent1')) {
      try {
        const decoded = nip19.decode(hash);
        const eventId = decoded.data?.id || decoded.data;
        console.log('Decoded event ID:', eventId);
        showStatus('Loading poll...', 'loading');
        document.getElementById('poll-list-container').innerHTML = '';
        fetchPollEvent(eventId).catch((error) => {
          console.error('Fetch poll event error:', error);
          showStatus(`Error: ${error.message}`, 'error');
        })
      } catch (error) {
        console.error('Hash change error:', error);
        showStatus(`Error: ${error.message}`, 'error');
      }
    } else if (!hash) {
      init();
    }
  });

  init();
