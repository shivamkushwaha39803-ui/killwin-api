const express = require('express');
const cors = require('cors');
const { Client, Databases, ID, Query } = require('node-appwrite');

const app = express();
app.use(cors());
app.use(express.json());

// Appwrite Setup
const client = new Client()
    .setEndpoint('https://cloud.appwrite.io/v1') // Aapka Endpoint
    .setProject('6ab2b71c00...')                // Aapka Project ID
    .setKey('YOUR_APPWRITE_API_KEY');           // Aapki Secret API Key

const databases = new Databases(client);

// Exact Database & Collection IDs
const DATABASE_ID = 'WinGoDB';
const COLLECTION_BETS = 'bets';
const COLLECTION_TRANSACTIONS = 'transactions';
const COLLECTION_ROUNDS = 'wingo_rounds';
const COLLECTION_USERS = 'users';

// 1. Place Bet Route (Using exact column name: user_id)
app.post('/api/place-bet', async (req, res) => {
    try {
        const { user_id, gameId, period, select_type, select_value, amount } = req.body;

        // User balance check
        const user = await databases.getDocument(DATABASE_ID, COLLECTION_USERS, user_id);
        if (user.wallet_balance < amount) {
            return res.status(400).json({ error: 'Insufficient wallet balance' });
        }

        // Deduct balance
        await databases.updateDocument(DATABASE_ID, COLLECTION_USERS, user_id, {
            wallet_balance: user.wallet_balance - amount
        });

        // Save Bet using EXACT column name user_id
        const bet = await databases.createDocument(DATABASE_ID, COLLECTION_BETS, ID.unique(), {
            user_id: user_id,
            gameId: gameId,
            period: period,
            select_type: select_type,
            select_value: select_value,
            amount: Number(amount),
            status: 'pending',
            win_amount: 0
        });

        res.json({ success: true, bet });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Fetch User Bets (Querying by user_id)
app.get('/api/my-bets/:user_id', async (req, res) => {
    try {
        const { user_id } = req.params;
        const response = await databases.listDocuments(
            DATABASE_ID,
            COLLECTION_BETS,
            [Query.equal('user_id', user_id)]
        );
        res.json({ success: true, bets: response.documents });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
