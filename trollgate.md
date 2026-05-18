# GOAL

Trollgate is a web service to moderate signups for study groups, chat sessions, or free programming classes. All of these are usually offered for free -- and the problem is, people don't often value things which are given away for free.

Also, programming discussions are not profitable for participants who are unable or unwilling to create basic, useful accounts like GitHub.

## HOW TO PROCEED

We'd like to offer a web sign-up, probably hosted on CloudFlare, that serves:

* An event title
* An event date / time (fixed, or repeating)
* An event description
* Requirements to sign up

And then collects:

* A user's name
* A user's email

And verifies identity by:

* verifying the email OR using an email from a verified source (like GitHub OAuth)

And may, optionally require:

* a credit card payment of $5.

## REFINEMENTS

Because we're also managing events, we need the ability to:
* have a persistent, personalized link for each signed-up user
* allow the user to cancel, and if canceled more than 24 hours before the event, receive a refund IF $5 was charged
* Allow the scheduler to cancel, and if so, refund ALL users who paid deposits their $5 back
* Prevent users from signing up for event which have already begun
* Show how many people have signed up
* Have a max # of seats and display how many are available

## MINIMUM VIABLE PROTOTYPE

* Display event
* Manage event
* User sign up flow using GitHub
* Event owner can get a list of those verified reservations in both HTML and CSV format

 
