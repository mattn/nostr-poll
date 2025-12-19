import { createRxNostr, createRxForwardReq, uniq, verify } from 'https://esm.sh/rx-nostr';
import { nip19 } from 'https://esm.sh/nostr-tools@2.7.0';
import { filter, take, timeout } from 'https://esm.sh/rxjs@7.8.1';

// Wait for NostrLogin to be available
function initNostrLogin() {
    if (window.NostrLogin) {
        window.addEventListener('nlAuth', (e) => {
            console.log('nlAuth event:', e.detail);
            showStatus(`Authenticated: ${e.detail?.type || 'unknown'}`, 'success');
        });

        window.addEventListener('nlLogout', () => {
            console.log('nlLogout event');
            showStatus('Logged out', 'success');
        });

        window.NostrLogin.init({
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
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band'
];

rxNostr.setDefaultRelays(defaultRelays);

let pollEvent = null;
let selectedOption = null;

function showStatus(message, type = 'loading') {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
}

async function fetchPollEvent(eventId) {
    console.log('Fetching event ID:', eventId);
    return new Promise((resolve, reject) => {
        const rxReq = createRxForwardReq();

        rxNostr.use(rxReq).pipe(
            uniq(),
            take(1),
            timeout(10000)
        ).subscribe({
            next: (packet) => {
                console.log('Received packet:', packet);
                console.log('Event kind:', packet.event?.kind);
                console.log('Event ID:', packet.event?.id);
                if (packet.event && packet.event.kind === 1068) {
                    displayPoll(packet.event);
                    resolve();
                } else {
                    console.warn('Event is not kind 1068');
                }
            },
            error: (err) => {
                console.error('Fetch error:', err);
                showStatus('Failed to fetch poll event', 'error');
                reject(err);
            },
            complete: () => {
                console.log('Subscription completed');
            }
        });

        rxReq.emit({
            ids: [eventId],
            kinds: [1068]
        });
    });
}

async function checkUserVote(pollEventId) {
    try {
        // Get current user's pubkey
        let userPubkey = null;
        if (window.nostr && typeof window.nostr.getPublicKey === 'function') {
            userPubkey = await window.nostr.getPublicKey();
        } else if (window.NostrLogin) {
            userPubkey = await window.NostrLogin.getPubkey().catch(() => null);
        }
        
        if (!userPubkey) {
            return null; // Not logged in
        }
        
        console.log('Checking vote for user:', userPubkey);
        
        return new Promise((resolve) => {
            const rxReq = createRxForwardReq();
            let userVote = null;

            rxNostr.use(rxReq).pipe(
                uniq(),
                timeout(3000)
            ).subscribe({
                next: (packet) => {
                    if (packet.event && packet.event.kind === 1018 && packet.event.pubkey === userPubkey) {
                        // Find the vote option
                        for (const tag of packet.event.tags) {
                            let optionId = null;
                            if (tag[0] === 'poll_option' && tag[2]) {
                                optionId = tag[2];
                            } else if (tag[0] === 'response' && tag[1]) {
                                optionId = tag[1];
                            }
                            
                            if (optionId) {
                                userVote = optionId;
                                console.log('User already voted for:', optionId);
                                break;
                            }
                        }
                    }
                },
                error: () => resolve(userVote),
                complete: () => resolve(userVote)
            });

            rxReq.emit({
                kinds: [1018],
                authors: [userPubkey],
                '#e': [pollEventId]
            });

            setTimeout(() => resolve(userVote), 3000);
        });
    } catch (error) {
        console.error('Error checking user vote:', error);
        return null;
    }
}

async function fetchVoteResults(pollEventId) {
    console.log('Fetching votes for poll ID:', pollEventId);
    return new Promise((resolve) => {
        const votes = {};
        let eventCount = 0;
        const rxReq = createRxForwardReq();

        rxNostr.use(rxReq).pipe(
            uniq(),
            timeout(5000)
        ).subscribe({
            next: (packet) => {
                if (packet.event && packet.event.kind === 1018) {
                    eventCount++;
                    console.log(`Vote event #${eventCount}:`, packet.event);
                    console.log('Tags:', packet.event.tags);
                    
                    // Check e tag first
                    const eTag = packet.event.tags.find(t => t[0] === 'e');
                    console.log('e tag:', eTag);
                    
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
                            console.log('Found vote for option:', optionId);
                            votes[optionId] = (votes[optionId] || 0) + 1;
                            break; // Only count one vote per event
                        }
                    }
                }
            },
            error: () => {
                console.log(`Total vote events received: ${eventCount}`);
                console.log('Final votes:', votes);
                resolve(votes);
            },
            complete: () => {
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
            console.log(`Timeout - Total vote events received: ${eventCount}`);
            console.log('Timeout - Final votes:', votes);
            resolve(votes);
        }, 5000);
    });
}

async function fetchAuthorProfile(pubkey) {
    return new Promise((resolve) => {
        const rxReq = createRxForwardReq();

        rxNostr.use(rxReq).pipe(
            uniq(),
            take(1),
            timeout(5000)
        ).subscribe({
            next: (packet) => {
                if (packet.event && packet.event.kind === 0) {
                    try {
                        const profile = JSON.parse(packet.event.content);
                        resolve(profile);
                    } catch (e) {
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
    const container = document.getElementById('poll-container');
    const options = parsePollOptions(event);

    if (options.length === 0) {
        showStatus('No poll options found', 'error');
        return;
    }

    const question = event.content || 'Poll Question';
    
    // Parse custom emojis
    const emojis = parseEmojis(event);
    
    // Show loading state if fetching results
    if (showResults) {
        showStatus('Loading results...', 'loading');
    }
    
    // Check if user already voted
    const userVotedOption = await checkUserVote(event.id);
    console.log('User voted option:', userVotedOption);
    
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
    
    container.innerHTML = `
        <div class="poll-question">${replaceEmojis(question, emojis)}</div>
        ${userVotedOption ? `<div class="user-voted-notice">✓ 投票済み</div>` : ''}
        <ul class="poll-options" id="options-list">
            ${options.map((opt, idx) => {
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
        <button class="vote-button" id="vote-btn" ${showResults ? '' : 'disabled'}>${showResults ? '結果を更新' : '投票する'}</button>
        <div class="poll-meta">
            <div class="poll-author">
                ${authorPicture ? `<img src="${escapeHtml(authorPicture)}" alt="${escapeHtml(authorName)}" class="author-avatar">` : ''}
                <span>作成者: ${escapeHtml(authorName)}</span>
            </div>
            <div class="poll-time">${new Date(event.created_at * 1000).toLocaleString('ja-JP')}</div>
            ${showResults ? `<div class="poll-total">総投票数: ${totalVotes}</div>` : ''}
        </div>
    `;

    container.classList.add('visible');
    
    if (!showResults) {
        document.querySelectorAll('.poll-option').forEach(option => {
            option.addEventListener('click', () => {
                document.querySelectorAll('.poll-option').forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                selectedOption = option.dataset.optionId;
                document.getElementById('vote-btn').disabled = false;
            });
        });

        document.getElementById('vote-btn').addEventListener('click', submitVote);
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
    showStatus('Submitting vote...', 'loading');

    try {
        showStatus('Checking login status...', 'loading');
        // Check if user is logged in with nostr-login
        let nlPubkey;
        try {
            nlPubkey = await Promise.race([
                window.NostrLogin.getPubkey(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getPubkey timeout')), 5000))
            ]);
        } catch (e) {
            nlPubkey = null;
            showStatus('getPubkey failed or timeout, trying anyway...', 'loading');
        }
        
        showStatus(`Login: ${nlPubkey ? nlPubkey.slice(0, 8) + '...' : 'none'}`, 'loading');
        
        let signedEvent;
        const voteEvent = {
            kind: 1018,
            content: '',
            tags: [
                ['e', pollEvent.id, '', 'poll'],
                ['poll_option', '0', selectedOption]
            ],
            created_at: Math.floor(Date.now() / 1000),
            pubkey: nlPubkey || ''
        };

        // Try NIP-07 extension first, then nostr-login
        if (window.nostr && typeof window.nostr.signEvent === 'function' && !nlPubkey) {
            showStatus('Using NIP-07 extension...', 'loading');
            signedEvent = await window.nostr.signEvent(voteEvent);
        } else {
            // Use nostr-login
            if (!nlPubkey) {
                showStatus('Please login (redirecting)...', 'loading');
                await window.NostrLogin.launch();
                showStatus('Returned from login, getting pubkey...', 'loading');
                nlPubkey = await window.NostrLogin.getPubkey();
                voteEvent.pubkey = nlPubkey;
                showStatus(`Logged in as ${nlPubkey.slice(0, 8)}...`, 'loading');
            }
            
            showStatus('Requesting signature (check nsec.app)...', 'loading');
            // Wait for signEvent with timeout
            signedEvent = await Promise.race([
                window.NostrLogin.signEvent(voteEvent),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('No response from nsec.app after 60s. Please refresh and try again.')), 60000)
                )
            ]);
        }
        
        showStatus('Signature received, checking...', 'loading');
        if (!signedEvent || !signedEvent.sig) {
            throw new Error('Invalid signed event: ' + JSON.stringify(signedEvent));
        }
        
        showStatus('Publishing vote to relays...', 'loading');
        await publishEvent(signedEvent);
        
        showStatus('Vote submitted successfully!', 'success');
        
        // Show results after voting
        setTimeout(() => {
            displayPoll(pollEvent, true);
        }, 1000);
    } catch (error) {
        const errorMsg = error.message || error.toString();
        showStatus(`Error: ${errorMsg}`, 'error');
        voteBtn.disabled = false;
    }
}

async function publishEvent(event) {
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

    const hash = window.location.hash.slice(1);
    const urlParams = new URLSearchParams(window.location.search);
    const nevent = hash || urlParams.get('id');

    if (!nevent) {
        showStatus('No poll ID found in URL. Use #nevent1... or ?id=nevent1...', 'error');
        return;
    }

    if (!nevent.startsWith('nevent1')) {
        showStatus('Invalid nevent format', 'error');
        return;
    }

    try {
        const decoded = nip19.decode(nevent);
        const eventId = decoded.data?.id || decoded.data;

        await fetchPollEvent(eventId);
    } catch (error) {
        console.error('Init error:', error);
        showStatus(`Error: ${error.message}`, 'error');
    }
}

init();
