Hooks.once('init', function() {
    game.settings.register('herohome', 'token', {
        name: 'herohome token',
        hint: 'This is the token for your account, dont share it!',
        scope: 'client',
        config: true,
        default: '',
        type: String,
    });

    console.log('Initialized HeroHome-Module');
});

Hooks.once('ready', function() {
Hooks.on('renderActorSheetV2', async (app, html, data) => {
    const button = $('<a class="herohome-button" title="HeroHome Import/export"><i class="fa-solid fa-vault navIcon" style="place-self: center;"></i>HeroHome</a>');
    
    button.on('click', async (event) => {
        let token = await game.settings.get('herohome', 'token');
        if (!token) {
            const dialogContent = `
                <p>Please set your HeroHome token to access the import/export feature.</p>
                <p>Visit the HeroHome website to generate a token:</p>
                <a href="https://herohome.me/secret_key/" target="_blank">Generate Token</a>
                <div class="herohome-token-input">
                    <label for="herohome-token">Enter Token:</label>
                    <input type="text" id="herohome-token" name="herohome-token">
                </div>
            `;
            
            const dialogOptions = {
                title: 'Set HeroHome Token',
                content: dialogContent,
                buttons: {
                    ok: {
                        icon: '<i class="fas fa-check"></i>',
                        label: 'OK',
                        callback: async (html) => {
                            const enteredToken = html.find('#herohome-token').val();
                            if (enteredToken) {
                                token = enteredToken;
                                await game.settings.set('herohome', 'token', token);
                                await loadCharacterList(app.actor);
                            }
                        }
                    }
                },
                default: 'ok'
            };

            new Dialog(dialogOptions).render(true);
        } else {
            await loadCharacterList(app.actor);
        }
    });

    const $html = $(html);
    const header = $html.closest('.application').find('.window-header');
    if (header.length) {
    const closeButton = header.find('button[data-action="close"]');
    if (closeButton.length) {
        button.addClass("header-control");
        closeButton.before(button); // ← direkt davor einfügen
    } else {
        header.append(button); // fallback
    }
    }
    console.log(app.actor.flags.herohome.lastsync);
    checkForNewVersion(app.actor);
});


    HeroHome.startTimer();
    if (game.user.isGM) {
        // Select the journal sidebar container
        let journalSidebar = $(".journal-sidebar");
        
        // Create the new button element
        let newButton = $("<button>").addClass("heroHomeSyncJournal")
        .html('<i class="fas fa-icon-of-your-choice"></i> <b>Hero Home Sync</b>')
        .on('click', syncJournalToFallback);
        // Append the new button just after the header inside the journalSidebar
        journalSidebar.find(".directory-header").after(newButton);
    }
});

async function checkForNewVersion(currentCharacter) {
    let token = await game.settings.get('herohome', 'token');
    try {
        const response = await fetch(`https://herohome.me/api/download_character/${currentCharacter.flags.herohome.characterid}/`, {
            headers: {
                'Secret-Key': token,
            },
        });

        if (response.ok) {
            const characterData = await response.json();

            // Use lastsync from the fetched characterData
            const heroHomeLastSync = new Date(characterData.flags.herohome.lastsync);
            const actorLastSync = new Date(currentCharacter.flags.herohome?.lastsync);

            if (new Date(heroHomeLastSync) > new Date(actorLastSync)) {
                const updateDialogOptions = {
                    title: 'Herohome Sync',
                    content: '<p>A newer version of this character is available on HeroHome. Do you want to update?</p>',
                    buttons: {
                        yes: {
                            icon: '<i class="fas fa-download"></i>',
                            label: 'Update',
                            callback: async () => {
                                await currentCharacter.update({
                                    'flags.herohome.lastsync': characterData.flags.herohome.lastsync,
                                });
                                // Remove old items from the actor
                                const itemIDs = currentCharacter.items.map(i => i.id);
                                await currentCharacter.deleteEmbeddedDocuments("Item", itemIDs);

                                // Remove old effects from the actor
                                const effectIDs = currentCharacter.effects.map(e => e.id);
                                await currentCharacter.deleteEmbeddedDocuments("ActiveEffect", effectIDs);

                                // Update the actor with the new data
                                await currentCharacter.update(characterData);
                                await currentCharacter.update({
                                    'flags.herohome.lastsync': characterData.flags.herohome.lastsync,
                                });
                            }
                        },
                        no: {
                            icon: '<i class="fas fa-times"></i>',
                            label: 'Cancel',
                            callback: () => {}
                        }
                    },
                    default: 'no'
                };

                new Dialog(updateDialogOptions).render(true);
            }
        } else {
            console.error('Error:', response.status);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

async function loadCharacterList(currentCharacter) {
    let token = await game.settings.get('herohome', 'token');
    const dialogOptions = {
        title: 'HeroHome',
        content: '<h1 class="heroHomeSectionHeader">Current Character:</h1><div class="herohome-dialog-content">Loading...</div>',
        buttons: {},
        height: 800,
        resizable: true,
    };
    if(HeroHome._screen == null){
        let dialog = new Dialog(dialogOptions);
        dialog.render(true);
        dialog.position.height = dialogOptions.height;
        HeroHome._screen = dialog;
    }
    else{
        HeroHome._screen.render(true);
    }
    try {
        const response = await fetch('https://herohome.me/api/characters/', {
            headers: {
                'Secret-Key': token,
            },
        });

        if (response.ok) {
            const textResponse = await response.text();
            if (!textResponse) {
                console.error("Empty response from the server.");
                return;
            }
            let characters;
            try {
                characters = JSON.parse(textResponse);
            } catch (err) {
                console.error("Failed to parse server response:", textResponse);
                return;
            }
            displayCharacterList(characters, currentCharacter, token);
        } else {
            console.error('Error:', response.status);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}
function syncJournalToFallback() {
    const folders = Array.from(game.journal.folders.values()).map(folder => folder.toObject());
    const journalEntries = game.journal.contents.map(j => j.toObject());

    // Create a combined data structure
    const combinedData = {
        folders: folders,
        journalEntries: journalEntries
    };

    // Convert the combined data to a string for transmission
    const dataToSend = JSON.stringify(combinedData);

    // Make an AJAX request to your Django backend
    $.ajax({
        type: 'POST',
        url: 'https://herohome.me/api/worldsync/',
        headers: {
            'Content-Type': 'application/json',
            'Secret-Key': game.settings.get('herohome', 'token')
        },
        data: JSON.stringify({
            foundry_world_id: game.world.id,
            journal_content: dataToSend  // Send the combined data
        }),
        success: function(response) {
            console.log("Successfully synced journals:", response);
        },
        error: function(error) {
            console.error("Error syncing journals:", error);
        }
    });
}
function timeDifference(current, previous) {
    const msPerMinute = 60 * 1000;
    const msPerHour = msPerMinute * 60;
    const msPerDay = msPerHour * 24;
    const msPerMonth = msPerDay * 30;
    const msPerYear = msPerDay * 365;

    const elapsed = current - previous;

    if (elapsed < msPerMinute) {
         return Math.round(elapsed/1000) + ' seconds ago';   
    } else if (elapsed < msPerHour) {
         return Math.round(elapsed/msPerMinute) + ' minutes ago';   
    } else if (elapsed < msPerDay ) {
         return Math.round(elapsed/msPerHour ) + ' hours ago';   
    } else if (elapsed < msPerMonth) {
         return Math.round(elapsed/msPerDay) + ' days ago';   
    } else if (elapsed < msPerYear) {
         return Math.round(elapsed/msPerMonth) + ' months ago';   
    } else {
         return Math.round(elapsed/msPerYear ) + ' years ago';   
    }
}
function formatDate(dateString) {
    const date = new Date(dateString);
    if (isNaN(date)) {
        return "This version of the character has not been uploaded yet";
    }
    return timeDifference(new Date(), date);
}
function displayCharacterList(characters, currentCharacter, token) {
    const currentSystemId = game.system.id;
    let createdAt = 'Not Uploaded Yet';
    let dialog = $('.herohome-dialog-content').closest('.dialog')[0];
    let content = $('.herohome-dialog-content');

    let synced = currentCharacter.flags.herohome?.synced ?? false;

    let synchedStyle = "hhSynced";
    const filteredCharacters = characters.filter(character => 
        !character.data._stats || character.data._stats.systemId === currentSystemId
    );
    if(!synced)synchedStyle = "";
    //Remove old Content
    content.empty();
    let isUploaded = false;
    // Create the character list
    let characterList = $('<ul class="herohome-character-list"></ul>');
    filteredCharacters.forEach((character) => {
        if(character.data._stats)
            console.log(character.name + " | system: "+ character.data._stats.systemId);
        else
        console.log(character.name + " | nosystem");
        let isCharacter = "";
        let syncClass = "";
        if (character.id === (currentCharacter?.flags?.herohome?.characterid || "")) {
            isCharacter = "hhThisActor"
            isUploaded = true;
            createdAt = character.created_at;
            if(synced)
                syncClass = "hhSynced";
        }
        const characterItem = `
            <li class="herohome-character `+isCharacter+ " " + syncClass+`">
                <img src="${character.image_url}" alt="${character.name}">
                <div>
                    <span class="herohome-character-name">${character.name}</span><br>
                    <span class="herohome-character-created-at">${formatDate(character.created_at)}</span>
                </div>
                <div>
                    <button class="herohome-download" data-character-id="${character.id}"><i class="fa-solid fa-cloud-arrow-down"></i></button>
                    <button class="herohome-overwrite" data-character-id="${character.id}"><i class="fa-solid fa-cloud-arrow-up"></i></button>
                    <button class="herohome-sync `+syncClass+`" disabled data-character-id="${character.id}"><i class="fa-solid fa-rotate"></i></button>
                </div>
            </li>
        `;
        characterList.append(characterItem);
    });


    let isUploadedStyle = 'notUploaded';

    if(isUploaded){
        //let elapsed = moment(createdAt).fromNow();
        isUploadedStyle = 'isUploaded';
    }

    // Create the current character section
    const currentCharacterSection = $('<div class="herohome-current-character '+isUploadedStyle+'" id="'+currentCharacter.id+'"></div>');
    const currentCharacterImage = $(`<img class="herohome-currentCharacterImage" src="${currentCharacter.img}" alt="${currentCharacter.name}">`);
    const characterDetailsDiv = $('<div class="herohome-character-details-div"></div>');
    const characterName = $('<span class="herohome-character-name"></span>').text(currentCharacter.name);
    const characterCreatedAt = $('<span class="herohome-character-created-at"></span>').text(formatDate(createdAt));
    characterDetailsDiv.append(characterName, $('<br>'), characterCreatedAt);
    let syncedSpan = $('<span class="herohome-character-sync"></span>').text("Automatic Sync enabled.");
    if(synced)
        characterDetailsDiv.append(syncedSpan);
        else{
            syncedSpan = $('<span class="herohome-character-sync" style="color:black!important"></span>').text("Automatic Sync disabled.");
            characterDetailsDiv.append(syncedSpan);
        }
    const characterChangedDiv = $('<div class="herohome-character-changed-div"></div>');
    const uploadButton = $(`<button title="Click to Upload" class="herohome-upload `+isUploadedStyle+`" data-character-id="${currentCharacter.id}"><i class="fa-solid fa-cloud-arrow-up"></i></button>`);
    
    let syncButton = $(`<button title="Click to enable Sync (Automatic Upload)" class="herohome-sync `+synchedStyle+`" data-character-id="${currentCharacter.id}"><i class="fa-solid fa-rotate"></i></button>`);
    if(!isUploaded) syncButton = $(`<button title="You can't sync this character because he hasn't been uploaded yet." disabled class="herohome-sync" data-character-id="${currentCharacter.id}"><i class="fa-solid fa-rotate"></i></button>`);
    
    characterChangedDiv.append(uploadButton, syncButton);
    currentCharacterSection.append(currentCharacterImage, characterDetailsDiv, characterChangedDiv);
    let HeroHome = '<h1 class="heroHomeSectionHeader">Character List:</h1>';

    // Add the new content to the dialog
    $(dialog).find('.herohome-dialog-content').append(currentCharacterSection,HeroHome,characterList);

    attachButtonListeners(token);
}
async function uploadCharacterImages(characterId, characterImageBlob, tokenImageBlob, actorid) {
    let token = await game.settings.get('herohome', 'token');
    const formData = new FormData();
    formData.append('character_id', characterId);
    formData.append('character_image', characterImageBlob, "character_image.png");
    formData.append('token_image', tokenImageBlob, "token_image.png");

    try {
        const response = await fetch('https://herohome.me/api/upload_character_images/', {
            method: 'POST',
            body: formData,
            headers: {
                'Secret-Key': token,
            },
        });

        if (response.ok) {
            const responseData = await response.json();
            const characterImageUrl = responseData.character_image_url;
            const tokenImageUrl = responseData.token_image_url;

            // Assuming you have the actor object available
            const actor = game.actors.get(actorid);
            if (actor) {
                // Update the actor's image paths
                await actor.update({
                    "img": characterImageUrl,
                    "token.img": tokenImageUrl
                });

                ui.notifications.notify("Images uploaded and updated successfully!");
            } else {
                console.error('Error: Actor not found');
            }
        } else {
            console.error('Error:', response.status);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}
function attachButtonListeners(token) {
    $('.herohome-upload').on('click', async function () {
        const characterId = $(this).data('character-id');
        console.log(characterId);
        try {
            const actor = game.actors.get(characterId);
            if (actor) {
                const response = await fetch('https://herohome.me/api/upload_character/', {
                    method: 'POST',
                    body: JSON.stringify(actor),
                    headers: {
                        'Content-Type': 'application/json',
                        'Secret-Key': token,
                    },
                });

                if (response.ok) {
                    ui.notifications.notify("Herohome | " + actor.name + " was successfully uploaded!");
                      const responseData = await response.json();
                      const characterId = responseData.characterid;
                      ui.notifications.notify("CharacterID: " + characterId);
                      actor.update({
                        'flags.herohome.synced': false,
                        'flags.herohome.characterid': characterId
                      });
                       // Fetch and append the character image
                    const characterImageResponse = await fetch(actor.img);
                    const characterImageBlob = await characterImageResponse.blob();
                    
                    // Fetch and append the token image
                    const tokenImageResponse = await fetch(actor.prototypeToken.texture.src);
                    const tokenImageBlob = await tokenImageResponse.blob();
                    await uploadCharacterImages(characterId, characterImageBlob, tokenImageBlob, actor.id);
                    await loadCharacterList(actor);
                } else {
                    console.error('Error:', response.status);
                }
            } else {
                // Handle the case when the actor is not found
            }
        } catch (error) {
            console.error('Error:', error);
        }
    });
    $('.herohome-sync').on('click', async function () {
        const characterId = $(this).data('character-id');
        console.log(characterId);
        const actor = game.actors.get(characterId);
        actor.update({
            'flags.herohome.synced': !actor.flags.herohome.synced,
            'flags.herohome.id': characterId,
        });
        await loadCharacterList(actor);
    });

    async function overwriteCharacter(characterId, data) {
        try {
          const actor = data;
          let token = await game.settings.get('herohome', 'token');
          if (actor) {
            const response = await fetch(
              `https://herohome.me/api/overwrite_character/${characterId}/`,
              {
                method: 'POST',
                body: JSON.stringify(actor),
                headers: {
                  'Content-Type': 'application/json',
                  'Secret-Key': token,
                },
              }
            );
    
            if (response.ok) {
              const responseData = await response.json();
              const newCharacterID = responseData.characterid;
              const { created_at } = responseData; // Get the created_at field from the response
              ui.notifications.notify('Character ' + data.name + ' has been synced to HeroHome');
              actor.update({
                'flags.herohome.synced': false,
                'flags.herohome.characterid': newCharacterID,
                'flags.herohome.lastsync': created_at,
              });
              await loadCharacterList(actor);
            } else {
              console.error('Error:', response.status);
            }
          } else {
            // Handle the case when the actor is not found
          }
        } catch (error) {
          console.error('Error:', error);
        }
    }
    
    $('.herohome-overwrite').on('click', function () {
        const characterId = $(this).data('character-id');
        let data = game.actors.get($(".herohome-current-character")[0].id);
        overwriteCharacter(characterId, data);
    });

    async function downloadAndOverwriteCharacter(characterId, actor) {
        try {
            let token = await game.settings.get('herohome', 'token');
            const response = await fetch(`https://herohome.me/api/download_character/${characterId}/`, {
                headers: {
                    'Content-Type': 'application/json',
                    'Secret-Key': token
                }
            });
    
            if (response.ok) {
                const characterData = await response.json();
    
                if (actor) {
                    // Remove old items from the actor
                    const itemIDs = actor.items.map(i => i.id);
                    await actor.deleteEmbeddedDocuments("Item", itemIDs);
    
                    // Remove old effects from the actor
                    const effectIDs = actor.effects.map(e => e.id);
                    await actor.deleteEmbeddedDocuments("ActiveEffect", effectIDs);

                    // Now, update the actor with the new data
                    await actor.update(characterData);
    
                    // Update additional flags
                    await actor.update({
                        'flags.herohome.characterid': characterId,
                        'flags.herohome.lastsync': characterData.flags.herohome.lastsync,
                    });
    
                    // Rerender the actor's sheet
                    actor.sheet.render(true);
    
                    ui.notifications.notify('Character ' + actor.name + ' has been updated');
                    await loadCharacterList(actor);
                } else {
                    console.error('Error: Actor not found');
                }
            } else {
                console.error('Error:', response.status);
            }
        } catch (error) {
            console.error('Error:', error);
        }
    }
    
    $('.herohome-download').on('click', function () {
        const characterId = $(this).data('character-id');
        let data = game.actors.get($(".herohome-current-character")[0].id);
        downloadAndOverwriteCharacter(characterId, data);
    });
}
window.HeroHome = class HeroHome {
    static _screen;
    static timer = 0;
    static _lastCharacterVersion;

    static startTimer() {
        if(game.user.character)
            this._lastCharacterVersion = JSON.stringify(game.user.character);
            
        this.timerInterval = setInterval(() => {
            // Code to execute every 1 minute
            this.timer++;
            if(game.user.character != null){
                if(game.user.character.flags.herohome?.synced == true){
                   
                    if(game.user.character.flags.herohome?.characterid){
                        if (this._lastCharacterVersion !== JSON.stringify(game.user.character)) {
                            HeroHome.syncCharacter(game.user.character.flags.herohome.characterid, game.user.character);
                        }
                    }
                }
            }
        }, 600000); // 60000 milliseconds = 1 minute
    }

    static stopTimer() {
        clearInterval(this.timerInterval);
    }

    static async syncCharacter(characterId, data) {
        try {
          const actor = data;
          let token = await game.settings.get('herohome', 'token');
          if (actor) {
            const response = await fetch(
              `https://herohome.me/api/overwrite_character/${characterId}/`,
              {
                method: 'POST',
                body: JSON.stringify(actor),
                headers: {
                  'Content-Type': 'application/json',
                  'Secret-Key': token,
                },
              }
            );
    
            if (response.ok) {
                const responseData = await response.json();
                const { created_at } = responseData; // Get the created_at field from the response
                await actor.setFlag('herohome', 'lastsync', created_at); // Save the created_at value to actor.flags.herohome.lastsync
                ui.notifications.notify('Character ' + game.user.character.name + ' has been synced to HeroHome');
                this._lastCharacterVersion = JSON.stringify(game.user.character);
            } else {
                console.error('Error:', response.status);
            }
          } else {
            // Handle the case when the actor is not found
          }
        } catch (error) {
          console.error('Error:', error);
        }
    }
    
};