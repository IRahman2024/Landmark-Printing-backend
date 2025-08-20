const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const express = require('express');
const cors = require('cors');
const app = express();
const jwt = require('jsonwebtoken');
const SSLCommerzPayment = require('sslcommerz-lts');
require('dotenv').config()
const port = 3000 || process.env.PORT;
const stripe = require("stripe")(process.env.STRIPE_KEY);
const nodemailer = require("nodemailer");

// SMTP server config
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465 ,
    secure: true,
    auth: {
        user: process.env.app_email,
        pass: process.env.app_pass,
    },
});


// console.log(process.env.STRIPE_KEY);
//middleware
app.use(cors({
    origin: [
        // "https://titan-s-rest.web.app",
        // "https://titan-s-rest.firebaseapp.com",
        "http://localhost:5173",
        "http://localhost:5174"
    ]
}));
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.8sux4by.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {

        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        // // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");



        const secret = process.env.ACCESS_TOKEN_SECRET;
        // console.log(secret);
        const userCollection = client.db("Buy&Borrow").collection("users");
        const productsCollection = client.db("Buy&Borrow").collection("products");
        const reviewsCollection = client.db("Buy&Borrow").collection("reviews");
        const requestCollection = client.db("Buy&Borrow").collection("requests");
        // const cartsCollection = client.db("Buy&Borrow").collection("carts");
        const paymentCollection = client.db("Buy&Borrow").collection("payments");
        const complainCollection = client.db("Buy&Borrow").collection("complains");
        const wishCollection = client.db("Buy&Borrow").collection("wish");
        const usersCollection = client.db("Buy&Borrow").collection("users");

        const landmarkPayments = client.db("Buy&Borrow").collection("landmarkPayments");
        const landmarkFeedback = client.db("Buy&Borrow").collection("landmarkFeedback");

        //middlewares
        const verifyToken = (req, res, next) => {
            // console.log('inside verify token', req.headers.authorization);
            if (!req.headers.authorization) {
                return res.status(401).send({ message: 'unauthorized access' });
            }
            const token = req.headers.authorization;
            jwt.verify(token, secret, (err, decoded) => {
                if (err) {
                    return res.status(401).send({ message: 'unauthorized access' });
                }
                req.decoded = decoded;
                next();
            });
        }

        //use verify admin after verifyToken
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            const isAdmin = user?.role === 'admin';
            if (!isAdmin) {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }

        //jwt api
        app.post('/jwt', async (req, res) => {
            // console.log('jwt hit!!');

            const user = req.body;
            const token = jwt.sign(user, secret, { expiresIn: '1h' })
            // console.log(token);

            res.send({ token })
        })

        app.get('/test', verifyToken, async (req, res) => {
            console.log("test");
            // console.log(req.body);
            res.send('You should not see this!')
        })

        //payment api
        app.get('/payments/:id', async (req, res) => {
            const query = { userId: req.params.id };

            const result = await paymentCollection.find(query).toArray();
            res.send(result);
        })
        // landmark starts
        // stripe post api
        app.post('/create-checkout-session', async (req, res) => {
            const { amount, currency = 'usd', id } = req.body;

            // console.log(req.body);

            try {
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'], // Add other methods like 'alipay', 'grabpay' if needed
                    line_items: [
                        {
                            price_data: {
                                currency,
                                product_data: {
                                    name: 'Order Total',
                                },
                                unit_amount: amount * 100, // Amount in cents
                            },
                            quantity: 1,
                        },
                    ],
                    mode: 'payment',
                    success_url: 'http://localhost:5173/success?sessionId={CHECKOUT_SESSION_ID}',
                    cancel_url: 'http://localhost:5173/dashboard/cart?session_id=NULL',
                    metadata: { order_id: id }
                });
                res.json({ sessionId: session.id });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        })

        app.post('/verify-payment', async (req, res) => {
            const { sessionId } = req.body;
            console.log(sessionId);

            try {
                const session = await stripe.checkout.sessions.retrieve(sessionId);
                if (session.payment_status === 'paid') {
                    const orderId = session.metadata.order_id;  // From metadata added earlier
                    // console.log(session);

                    await landmarkPayments.updateOne(
                        { _id: new ObjectId(orderId) },
                        { $set: { paid_status: true, transaction_id: session.payment_intent } },
                        { upsert: true }
                    );
                    res.json({ success: true });
                } else {
                    res.json({ success: false });
                }
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.get('/payment-details/:sessionId', async (req, res) => {
            // console.log('sessionId', req.params);
            try {
                const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
                // console.log('session', session);

                res.json({
                    amount: session.amount_total,
                    currency: session.currency,
                    status: session.payment_status,
                    email: session.customer_details.email,
                    name: session.customer_details.name,
                    transaction_id: session.payment_intent,
                    method: session.payment_method_types,
                    order_id: session.metadata.order_id
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.post('/send-email/:email', async (req, res) => {
            // console.log('hit');
            
            const email = req.params.email;
            // const data = req.body.data;
            const { htmlString } = req.body
            // console.log(email);
             

            try {
                const info = await transporter.sendMail({
                    from: `"Landmark Team" <${process.env.app_email}>`, // sender address
                    to: email, // list of receivers
                    // to: email, // list of receivers
                    subject: "Billing Receipt From Landmark Printing", // Subject line
                    // text: "Hello world?", // plain text body
                    html: htmlString, // html body
                });

                console.log("Message sent: %s", info.messageId);
                // console.log("Preview URL: %s", nodemailer.getTestMessageUrl(info));
                res.sendStatus(200);
            } catch (err) {
                console.error("Error while sending mail", err);
            }
        });

        app.post('/addFeedback', async (req, res) => {
            const { email, feedback } = req.body;
            // console.log('feedback', req.body);
            const result = await landmarkFeedback.insertOne(req.body);
            res.send({ result });           
        })

        app.get('/landmarkFeedback', async (req, res) => {
            const result = await landmarkFeedback.find().toArray();
            // console.log('landmark feedback', result);
            res.send(result);
        })

        app.listen(process.env.PORT || 4000, () => {
            console.log(`Server running on port ${process.env.PORT}`);
        });

        // save order details
        app.post('/due-payments', async (req, res) => {
            const payment = req.body;
            const result = await landmarkPayments.insertOne(payment);

            // console.log('payment info', payment);
            // console.log(result);
            res.send({ result });
        })

        app.delete('/landmarkPayments/del', async (req, res) => {
            const { id } = req.body;
            // console.log('landmark payment delete', req.body);
            const query = { _id: new ObjectId(id) };
            const result = await landmarkPayments.deleteOne(query);
            res.send(result);
        })

        app.get('/order-details/:id', async (req, res) => {
            const id = req.params.id;
            // console.log('landmark email', id);
            const query = { _id: new ObjectId(id) };
            const result = await landmarkPayments.find(query).toArray();
            res.send(result);
        })

        app.get('/landmarkPayments/:email', async (req, res) => {
            const email = req.params.email;
            // console.log('landmark email', email);
            const query = { contact_email: email };
            const result = await landmarkPayments.find(query).toArray();
            res.send(result);
        })

        //landmark ends
        //meals api
        app.get('/mealsAdmin', async (req, res) => {
            const { likeSort, reviewSort } = req.query;

            // console.log('likeSort: ', reviewSort);

            if (likeSort) {
                // console.log('likeSort', reviewSort);
                const result = await mealsCollection.find().sort({ 'likeCount': likeSort }).toArray();
                // console.log(result);
                res.send(result);
            }

            if (reviewSort) {
                // console.log('reviewSort', reviewSort);
                const result = await mealsCollection.find().sort({ 'reviewCount': reviewSort }).toArray();
                // console.log(result);
                res.send(result);
            }

            else {
                // console.log(likeSort, reviewSort);
                const result = await mealsCollection.find().toArray();
                res.send(result);
            }
        })

        app.get('/meals', async (req, res) => {
            // console.log(req.headers);
            const { name, category, range } = req.query;
            const price = parseInt(range);
            // console.log('searched from query', category);
            const query = {
                status: { $eq: 'available' },
            }
            if (name && typeof name === 'string') {
                query.name = { $regex: name, $options: "i" };
            }
            if (category && typeof category === 'string') {
                query.category = category;
            }
            if (range) {
                query.price = { $gte: price };
            }
            // console.log(typeof(price));
            const cursor = mealsCollection.find(query);
            const result = await cursor.toArray();
            // console.log(result);
            res.send(result);
        })

        //meals upcoming only
        app.get('/mealsUpcoming', async (req, res) => {

            const query = {
                status: { $eq: 'upcoming' },
            }

            const cursor = mealsCollection.find(query);
            const result = await cursor.toArray();
            // console.log(result);
            res.send(result);
        })

        app.get('/upcomingMeals', async (req, res) => {

            const query = {
                status: { $eq: 'upcoming' },
            }

            // console.log(typeof(price));
            const result = await mealsCollection.find(query).sort({ 'likeCount': 1 }).toArray();

            res.send(result);
        })

        app.patch('/upcomingMeals/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    status: 'available'
                }
            }

            const result = await mealsCollection.updateOne(filter, updateDoc);

            res.send(result);
        })

        app.post('/meals/:email', verifyToken, verifyAdmin, async (req, res) => {
            // console.log(req);
            const email = req.params.email;
            const item = req.body;
            const result = await mealsCollection.insertOne(item);

            const filter = { email: email };
            const options = { upsert: true };
            const updateDoc = {
                $inc: { foodCount: 1 }
            }
            const result2 = await userCollection.updateOne(filter, updateDoc, options);

            res.send(result);
        })

        // app.patch('/likeCount/:id', async (req, res) => {
        //     const id = req.params.id;
        //     const filter = { _id: new ObjectId(id) };
        //     const options = { upsert: true };
        //     const updateDoc = {
        //         $inc: { likeCount: 1 }
        //     }
        //     const result = await mealsCollection.updateOne(filter, updateDoc, options);

        //     const filter2 = { requestId: id };
        //     const updateDoc2 = {
        //         $inc: { like: 1 }
        //     }
        //     const result2 = await requestCollection.updateMany(filter2, updateDoc2, options);

        //     res.send(result);
        // })

        app.get('/meals/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await mealsCollection.findOne(query);
            res.send(result);
        })

        //review count increment by 1
        app.patch('/mealsReview/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updateDoc = {
                $inc: { reviewCount: 1 }
            }
            //6664394ade3dd4139f635070
            const result = await mealsCollection.updateOne(filter, updateDoc, options);

            const filter2 = { requestId: id };
            const updateDoc2 = {
                $inc: { review: 1 }
            }
            const result2 = await requestCollection.updateMany(filter2, updateDoc2, options);

            // const filter3 = { reviewId: id };
            // const updateDoc3 = {
            //     $inc: { reviewCount: 1 }
            // }
            // const result3 = await reviewsCollection.updateMany(filter3, updateDoc3, options);

            res.send(result);
        })

        app.patch('/likeCount/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updateDoc = {
                $inc: { likeCount: 1 }
            }
            const result = await mealsCollection.updateOne(filter, updateDoc, options);

            const filter2 = { requestId: id };
            const updateDoc2 = {
                $inc: { like: 1 }
            }
            const result2 = await requestCollection.updateMany(filter2, updateDoc2, options);

            res.send(result);
        })

        //meal update api
        app.patch('/meals/:id', verifyToken, verifyAdmin, async (req, res) => {
            const item = req.body;
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };

            // console.log(item);

            const updateDoc = {
                $set: {
                    name: item.name,
                    category: item.category,
                    price: item.price,
                    image: item.image,
                    rating: item.rating,
                }
            }

            const result = await mealsCollection.updateOne(filter, updateDoc);
            res.send(result);
        })

        //likeArray
        app.patch('/meals-likeArray/:id', async (req, res) => {
            const array = req.body;
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };

            console.log(array);

            const updateDoc = {
                $set: {
                    likeArray: array
                }
            }

            const result = await mealsCollection.updateOne(filter, updateDoc);
            res.send(result);
        })

        // 
        app.delete('/meals/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await mealsCollection.deleteOne(query);
            res.send(result);
        })

        // search product
        app.get('/searchProducts', async (req, res) => {
            const tagsQuery = req.query.tags;

            if (!tagsQuery) {
                return res.status(400).json({ error: "Tags are required for search" });
            }

            const tagsArray = tagsQuery
                .toLowerCase()
                .split(',')
                .map(tag => tag.trim())
                .filter(tag => tag.length > 0);

            try {
                const result = await productsCollection.find({
                    tags: { $in: tagsArray }
                }).toArray();

                res.send(result);
            } catch (error) {
                console.error("Search error:", error);
                res.status(500).json({ error: "Internal server error" });
            }
        });


        //meal request api
        app.get('/request', verifyToken, async (req, res) => {
            let query = req.query;
            let { email, userName } = query;
            // console.log(query);

            if (userName && typeof userName === 'string') {
                // console.log('reached userName');
                query = { name: { $regex: userName, $options: "i" } };
                const result = await requestCollection.find(query).toArray();
                return res.send(result);
            }
            if (email && typeof email === 'string') {
                // console.log('reached email');
                query = { email: { $regex: email, $options: "i" } };
                const result = await requestCollection.find(query).toArray();
                return res.send(result);
            }

            const result = await requestCollection.find().toArray();
            res.send(result);
        })

        //, verifyToken
        app.get('/request/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email: email };
            const result = await requestCollection.find(query).toArray();
            res.send(result);
        })

        app.post('/request', verifyToken, async (req, res) => {
            const request = req.body;
            // console.log(request);
            const result = await requestCollection.insertOne(request);
            res.send(result);
        })

        //todo: requested chaged to served
        app.patch('/request/:id', verifyToken, async (req, res) => {
            // console.log('reached');
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    status: 'served'
                }
            }
            const result = await requestCollection.updateOne(filter, updateDoc);
            res.send(result);
        })

        app.delete('/request/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await requestCollection.deleteOne(query);
            res.send(result);
        })

        //review api
        // app.get('/reviews', async (req, res) => {
        //     const reviews = await reviewsCollection.find().toArray();

        //     const result = reviews.map(async (review) => {
        //         const meal = await mealsCollection.findOne({ _id: new ObjectId(review.reviewId) })

        //         review.mealInfo = meal;
        //         return review;
        //     })

        //     console.log(result);
        //     res.send(result);
        // })

        app.post('/addWish', async (req, res) => {
            const request = req.body;
            // console.log(request);
            const result = await wishCollection.insertOne(request);
            res.send(result);
        })

        app.get('/wish/:id', async (req, res) => {
            const userId = req.params.id;
            // console.log(request);
            const query = { userId: userId };
            const result = await wishCollection.find(query).toArray();
            res.send(result);
        })

        // all reviews
        app.get('/reviews', async (req, res) => {
            try {
                const reviews = await reviewsCollection.find().toArray();

                const result = await Promise.all(reviews.map(async (review) => {
                    const meal = await mealsCollection.findOne({ _id: new ObjectId(review.reviewId) });
                    review.mealInfo = meal;
                    return review;
                }));

                // console.log(result);
                res.send(result);
            } catch (error) {
                console.error(error);
                res.status(500).send('An error occurred while fetching reviews');
            }
        });

        //reviews based on product id
        app.get('/reviews/:id', async (req, res) => {
            const id = req.params.id;
            // console.log(id);
            const query = { productId: id };
            const result = await reviewsCollection.find(query).toArray();
            res.send(result);
        })

        //review based on user email
        app.get('/reviews-email/:email', async (req, res) => {
            try {
                const email = req.params.email;
                // console.log(email);
                const query = { email: email };
                const result = await reviewsCollection.find(query).toArray();

                res.send(result);
            }
            catch (error) {
                console.error(error);
                res.status(500).send('An error occurred while fetching reviews');
            }
        })

        //review based on user email and title
        app.get('/reviews-seller/:id', async (req, res) => {
            const id = req.params.id;
            // console.log(email);
            const query = {
                sellerId: id
            };
            const result = await reviewsCollection.find(query).toArray();
            res.send(result);
        })

        app.post('/reviews', verifyToken, async (req, res) => {
            const review = req.body;
            // console.log(review);
            const result = await reviewsCollection.insertOne(review);
            res.send(result);
        })

        //edit email review
        app.patch('/review/:id', async (req, res) => {
            const item = req.body;
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };

            console.log(item.review);
            const updateDoc = {
                $set: {
                    review: item.review,
                }
            }

            const result = await reviewsCollection.updateOne(filter, updateDoc);
            res.send(result);
        })

        //update like all that have user id
        //todo: email specific korte hbe
        app.patch('/review-like/:id', verifyToken, async (req, res) => {
            const item = req.body;
            const id = req.params.id;
            const filter = { reviewId: id };

            console.log(item.review);
            const updateDoc = {
                $set: {
                    like: true,
                }
            }

            const result = await reviewsCollection.updateMany(filter, updateDoc);
            res.send(result);
        })

        //delete review
        app.delete('/review/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await reviewsCollection.deleteOne(query);
            res.send(result);
        })

        app.post('/addProduct', async (req, res) => {
            const product = req.body;
            console.log(product);
            const result = await productsCollection.insertOne(product);
            res.send(result);
        })

        app.get('/allProducts', async (req, res) => {

            const result = await productsCollection.find().toArray();
            res.send(result);
        })

        app.get('/product/:id', async (req, res) => {
            const id = req.params.id;
            // const { title } = req.query;
            // console.log(email);
            const query = {
                _id: new ObjectId(id)
            };
            const result = await productsCollection.findOne(query);
            res.send(result);
        })

        app.get('/products/:category', async (req, res) => {
            const category = req.params.category;
            // const { title } = req.query;
            // console.log(email);
            const query = {
                category: category,
                status: 'approved'
            };
            const result = await productsCollection.find(query).toArray();
            res.send(result);
        })

        app.get('/getSellerProduct/:email', async (req, res) => {
            const email = req.params.email;
            // const { title } = req.query;
            console.log(email);
            const query = {
                sellerEmail: email
            };
            const result = await productsCollection.find(query).toArray();
            res.send(result);
        })

        app.put('/updateStatus', async (req, res) => {
            const id = req.query.id;
            const data = req.body;

            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updateDoc = {
                $set: {
                    status: data.status
                }
            };

            const result = await productsCollection.updateOne(filter, updateDoc, options);

            // console.log(result);
            res.send(result);
        })

        app.put('/updateProfile/:id', async (req, res) => {
            const id = req.params.id;
            const data = req.body;

            // console.log(id, data);


            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updateDoc = {
                $set: {
                    userName: data.name,
                    address: data.address,
                    number: data.number,
                    profilePic: data.profilePic,
                }
            };

            const result = await usersCollection.updateOne(filter, updateDoc, options);

            console.log(result);
            res.send(result);
        })
        app.put('/updateProfileImage/:id', async (req, res) => {
            const id = req.params.id;
            const data = req.body;

            // console.log(data.profilePic);


            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updateDoc = {
                $set: {
                    profilePic: data.profilePic,
                }
            };

            const result = await usersCollection.updateOne(filter, updateDoc, options);

            console.log(result);
            res.send(result);
        })



        //user apis
        //'/users'
        app.get('/users', async (req, res) => {
            let query = req.query;
            let { email, userName } = query;
            // console.log(query);

            if (userName && typeof userName === 'string') {
                // console.log('reached userName');
                query = { name: { $regex: userName, $options: "i" } };
                const result = await userCollection.find(query).toArray();
                return res.send(result);
            }
            if (email && typeof email === 'string') {
                // console.log('reached email');
                query = { email: { $regex: email, $options: "i" } };
                const result = await userCollection.find(query).toArray();
                return res.send(result);
            }

            const result = await userCollection.find().toArray();
            res.send(result);

        })

        app.get('/allUsersEmail', async (req, res) => {
            const options = {
                projection: { email: 1 }
            };
            const cursor = userCollection.find({}, options);
            const result = await cursor.toArray()

            const email = result.map(user => user.email);

            res.send(email);
        })

        app.get('/users/:email', async (req, res) => {
            const email = req.params.email;

            const query = { email: email };
            const user = await userCollection.findOne(query);
            res.send(user);
        })

        app.get('/getRoles', async (req, res) => {
            const email = req.query.email;

            const query = { email: email };
            const user = await userCollection.findOne(query);
            const role = user ? user.role : 'No role found!';
            // console.log(user);

            res.send(role);
        })

        app.put('/users/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const about = req.body;

            const filter = { email: email };
            const options = { upsert: true };

            console.log(about);

            if (about.package) {
                const updatedDoc = {
                    $set: {
                        badge: about.package
                    }
                };
                const user = await userCollection.updateOne(filter, updatedDoc, options);
                res.send(user);
            }

            else {
                const updatedDoc = {
                    $set: {
                        about: about
                    }
                };
                const user = await userCollection.updateOne(filter, updatedDoc, options);
                res.send(user);
            }


        })

        //checks if it's admin or not
        //verifyToken, verifyAdmin
        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            // // console.log('decoded email:', req.decoded.email);
            // //checks if requested email and user email matches or not
            // if (email !== req.decoded.email) {
            //     return res.status(403).send({ message: 'forbidden access' })
            // }

            const query = { email: email };
            const user = await userCollection.findOne(query);

            //checks if email owner is admin or not
            let admin = false;
            if (user) {
                admin = user?.role === 'admin';
            }
            res.send({ admin })
        })

        //verifyToken, verifyAdmin,
        app.patch('/users/admin/:id', async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await userCollection.updateOne(filter, updatedDoc)
            res.send(result)
        })

        app.post('/addUser', async (req, res) => {
            const user = req.body;
            const query = { email: user.email };
            console.log(query);
            console.log(user);

            const existingUser = await userCollection.findOne(query);
            if (existingUser) {
                console.log('user exists!');

                return res.send({ message: 'user already exists!', insertedId: null });
            }
            const result = await userCollection.insertOne(user);
            res.send(result);
        })

        app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await userCollection.deleteOne(query);
            res.send(result);
        })

        //admin api
        app.get('/admin/:email', async (req, res) => {
            const email = req.params.email;
            console.log(email);
            const query = { email: email };
            const user = await userCollection.findOne(query);
            res.send(user);
        })

        app.post('/complains', verifyToken, async (req, res) => {
            // console.log(req);
            const item = req.body;
            const result = await complainCollection.insertOne(item);

            res.send(result);
        })

        //verifyToken
        app.get('/complains/:email', verifyToken, async (req, res) => {
            // console.log(req);
            const email = req.params.email;
            const query = { email: email };
            const cursor = complainCollection.find(query);
            const result = await cursor.toArray();

            res.send(result);
        })

        //all complains
        app.get('/complains', verifyToken, verifyAdmin, async (req, res) => {
            const result = await complainCollection.find().toArray();

            res.send(result);
        })

        app.patch('/complains/:id', verifyToken, async (req, res) => {
            const item = req.body;
            const id = req.params.id;

            // console.log(item.details);
            // console.log(id);

            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    details: item.details
                }
            }
            const result = await complainCollection.updateOne(filter, updatedDoc)
            res.send(result)
        })

        //change by admin
        app.patch('/changeStatus/:id', verifyToken, verifyAdmin, async (req, res) => {
            const item = req.body;
            const id = req.params.id;

            // console.log(item);
            // console.log(id);

            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    status: item.status
                }
            }
            const result = await complainCollection.updateOne(filter, updatedDoc)
            res.send(result)
        })

        app.delete('/complains/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await complainCollection.deleteOne(query);
            res.send(result);
        })


    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('E-commerce server is running')
})

app.listen(port, () => {
    console.log('E-commerce app on port: ', port);
})